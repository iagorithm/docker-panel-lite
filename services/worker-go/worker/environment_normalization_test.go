package main

import "testing"

func TestEnvironmentTextMatchesPythonFormats(t *testing.T) {
	value := `export API_URL=https://example.test # comment
QUOTED="line one\nline two"
MULTILINE=first
 second`
	got := normalizeEnvironment(value)
	if got["API_URL"] != "https://example.test" {
		t.Fatalf("inline comment was not removed: %q", got["API_URL"])
	}
	if got["QUOTED"] != "line one\nline two" {
		t.Fatalf("quoted newline was not decoded: %q", got["QUOTED"])
	}
	if got["MULTILINE"] != "first\n second" {
		t.Fatalf("multiline value was not preserved: %q", got["MULTILINE"])
	}
}

func TestEnvironmentListAndTrailingJSONMatchPythonFormats(t *testing.T) {
	got := normalizeEnvironment([]interface{}{
		map[string]interface{}{"key": "FIRST", "value": "one"},
		map[string]interface{}{"name": "SECOND", "value": map[string]interface{}{"enabled": true}},
		`THIRD={"items":[1,2,],}`,
	})
	if got["FIRST"] != "one" {
		t.Fatalf("key/value list item was not parsed: %#v", got)
	}
	if got["SECOND"] != `{"enabled":true}` {
		t.Fatalf("name/value list item was not normalized: %q", got["SECOND"])
	}
	if got["THIRD"] != `{"items":[1,2]}` {
		t.Fatalf("trailing-comma JSON was not compacted: %q", got["THIRD"])
	}
}
