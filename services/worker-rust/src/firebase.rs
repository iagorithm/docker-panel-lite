use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use reqwest::blocking::{Client as HttpClient, RequestBuilder};
use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DATABASE_SCOPE: &str =
    "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email";

#[derive(serde::Deserialize)]
struct ServiceAccount {
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

struct CachedToken {
    value: String,
    expires_at: Instant,
}

pub struct FirebaseClient {
    database_url: String,
    account: ServiceAccount,
    http: HttpClient,
    token: Mutex<Option<CachedToken>>,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

impl FirebaseClient {
    pub fn new(database_url: &str, service_account_json: &str) -> Result<Self, String> {
        let database_url = database_url.trim().trim_end_matches('/').to_string();
        if database_url.is_empty() {
            return Err("Firebase database URL is required".into());
        }
        let mut account: ServiceAccount = serde_json::from_str(service_account_json)
            .map_err(|error| format!("parse service account JSON: {error}"))?;
        if account.client_email.trim().is_empty() || account.private_key.trim().is_empty() {
            return Err("service account must include client_email and private_key".into());
        }
        if account.token_uri.trim().is_empty() {
            account.token_uri = default_token_uri();
        }
        let http = HttpClient::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("create Firebase HTTP client: {error}"))?;
        Ok(Self { database_url, account, http, token: Mutex::new(None) })
    }

    pub fn get(&self, path: &str) -> Result<Value, String> {
        self.request(Method::GET, path, None, None).map(|(_, value)| value)
    }

    pub fn get_etag(&self, path: &str) -> Result<(String, Value), String> {
        self.request(Method::GET, path, None, Some(("X-Firebase-ETag", "true")))
    }

    pub fn put(&self, path: &str, value: &Value) -> Result<Value, String> {
        self.request(Method::PUT, path, Some(value), None).map(|(_, value)| value)
    }

    pub fn put_if_match(&self, path: &str, etag: &str, value: &Value) -> Result<Option<Value>, String> {
        match self.request_status(Method::PUT, path, Some(value), Some(("If-Match", etag)))? {
            (StatusCode::PRECONDITION_FAILED, _, _) => Ok(None),
            (status, _, body) if status.is_success() => parse_body(&body).map(Some),
            (status, _, body) => Err(firebase_error("conditional PUT", path, status, &body)),
        }
    }

    pub fn patch(&self, path: &str, value: &Value) -> Result<Value, String> {
        self.request(Method::PATCH, path, Some(value), None).map(|(_, value)| value)
    }

    pub fn delete(&self, path: &str) -> Result<(), String> {
        self.request(Method::DELETE, path, None, None).map(|_| ())
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        header: Option<(&str, &str)>,
    ) -> Result<(String, Value), String> {
        let (status, etag, response_body) = self.request_status(method.clone(), path, body, header)?;
        if !status.is_success() {
            return Err(firebase_error(method.as_str(), path, status, &response_body));
        }
        Ok((etag, parse_body(&response_body)?))
    }

    fn request_status(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        header: Option<(&str, &str)>,
    ) -> Result<(StatusCode, String, String), String> {
        let mut last_error = String::new();
        for attempt in 1..=3 {
            let token = self.access_token()?;
            let mut request: RequestBuilder = self.http.request(method.clone(), self.url(path)).bearer_auth(token);
            if let Some(value) = body {
                request = request.json(value);
            }
            if let Some((name, value)) = header {
                request = request.header(name, value);
            }
            match request.send() {
                Ok(response) => {
                    let status = response.status();
                    let etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                    let text = response.text().unwrap_or_default();
                    if is_retryable(status) && attempt < 3 {
                        std::thread::sleep(Duration::from_millis(250 * attempt * attempt));
                        continue;
                    }
                    return Ok((status, etag, text));
                }
                Err(error) => {
                    last_error = error.to_string();
                    if attempt < 3 {
                        std::thread::sleep(Duration::from_millis(250 * attempt * attempt));
                    }
                }
            }
        }
        Err(format!("Firebase {} {} request failed after retries: {last_error}", method, path))
    }

    fn access_token(&self) -> Result<String, String> {
        if let Some(cached) = self.token.lock().map_err(|_| "token cache lock poisoned")?.as_ref() {
            if Instant::now() + Duration::from_secs(60) < cached.expires_at {
                return Ok(cached.value.clone());
            }
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
        let claims = Claims {
            iss: &self.account.client_email,
            scope: DATABASE_SCOPE,
            aud: &self.account.token_uri,
            iat: now,
            exp: now + 3600,
        };
        let key = EncodingKey::from_rsa_pem(self.account.private_key.as_bytes())
            .map_err(|error| format!("parse service account private key: {error}"))?;
        let assertion = encode(&Header::new(Algorithm::RS256), &claims, &key)
            .map_err(|error| format!("sign Firebase JWT: {error}"))?;
        let response = self.http.post(&self.account.token_uri)
            .form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", assertion.as_str())])
            .send().map_err(|error| format!("OAuth token exchange failed: {error}"))?;
        let status = response.status();
        let body = response.text().unwrap_or_default();
        if !status.is_success() {
            return Err(format!("OAuth token exchange failed: {status}: {body}"));
        }
        let payload: Value = serde_json::from_str(&body).map_err(|error| format!("parse OAuth response: {error}"))?;
        let value = payload.get("access_token").and_then(Value::as_str).ok_or("OAuth response omitted access_token")?.to_string();
        let expires = payload.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
        *self.token.lock().map_err(|_| "token cache lock poisoned")? = Some(CachedToken {
            value: value.clone(),
            expires_at: Instant::now() + Duration::from_secs(expires),
        });
        Ok(value)
    }

    fn url(&self, path: &str) -> String {
        let path = path.trim_matches('/');
        if path.is_empty() { format!("{}/.json", self.database_url) } else { format!("{}/{}.json", self.database_url, path) }
    }
}

fn parse_body(body: &str) -> Result<Value, String> {
    if body.trim().is_empty() || body.trim() == "null" {
        Ok(Value::Null)
    } else {
        serde_json::from_str(body).map_err(|error| format!("parse Firebase response: {error}"))
    }
}

fn is_retryable(status: StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504)
}

fn firebase_error(operation: &str, path: &str, status: StatusCode, body: &str) -> String {
    format!("Firebase {operation} {path} failed: {status}: {}", body.trim())
}
