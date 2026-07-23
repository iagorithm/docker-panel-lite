package core

import "testing"

func TestRelativeFilePathMatchesPythonContract(t *testing.T) {
	valid := []string{"Dockerfile", "docker/compose.yml"}
	invalid := []string{"", "/Dockerfile", "../Dockerfile", "a/../Dockerfile", "docker/../..", "folder/", "~/Dockerfile", `docker\Dockerfile`, "bad\x00file"}
	for _, value := range valid {
		if !ValidateRelativeFilePath(value) {
			t.Errorf("expected valid relative file path: %q", value)
		}
	}
	for _, value := range invalid {
		if ValidateRelativeFilePath(value) {
			t.Errorf("expected invalid relative file path: %q", value)
		}
	}
}
