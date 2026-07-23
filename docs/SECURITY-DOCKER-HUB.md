# Docker Hub Security Checklist

## Urgent

- [ ] Revoke and replace the exposed Firebase Admin private key.
- [ ] Revoke and replace the exposed OpenAI API key.
- [ ] Revoke and replace the exposed GitHub token.
- [ ] Rotate `LOGS_AGENT_SECRET`.
- [ ] Plan the rotation of `CREDENTIAL_ENCRYPTION_KEY` and re-encrypt stored credentials.
- [ ] Remove every public Docker image/tag built with those credentials.

## Docker Hub

- [ ] Keep configured Python and Go worker images in a private repository.
- [ ] Never publish compiled or baked credentials to a public image.
- [ ] Rebuild `:py` and `:go` only after rotating all exposed secrets.
- [ ] Use immutable version tags in addition to `:py` and `:go`.
- [ ] Enable Docker Hub access tokens, least privilege and 2FA.
- [ ] Review collaborators, automated builds and repository visibility.

## Build and CI

- [ ] Keep `.env` outside Git and the normal Docker build context.
- [ ] Pass worker configuration only through BuildKit secrets.
- [ ] Store CI secrets in the CI provider, never in repository files.
- [ ] Prevent build logs from printing credentials or generated source.
- [ ] Add secret scanning for Git history, commits and Docker images.
- [ ] Run `docker run --rm <go-image> --check-config` before deployment.

## Before production

- [ ] Confirm old credentials no longer authenticate.
- [ ] Scan the rebuilt image for secrets.
- [ ] Test Firebase, Git, Docker and ngrok with rotated credentials.
- [ ] Verify the worker claim token is unique per installation.
- [ ] Document who can publish, delete and pull worker images.
