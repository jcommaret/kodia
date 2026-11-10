#!/usr/bin/env bash
# Reports the model catalog check (checkModelCatalog.mts) through one open GitHub issue labelled
# model-catalog, so its findings reach the repository owner by e-mail rather than as a failed run:
# - something needs a look, or the check could not run: the issue is opened, or updated with a comment
#   when the findings changed since the last run;
# - nothing needs a look: the open issue, if any, is closed.
#
# Usage: reportModelCatalog.sh <check exit code> <report file> <error file>
# Needs gh (GH_TOKEN, GH_REPO), GITHUB_REPOSITORY_OWNER and RUN_URL, all set by model-catalog.yml.

set -euo pipefail

status=$1
report_file=$2
error_file=$3
label=model-catalog

issue=$(gh issue list --label "$label" --state open --limit 1 --json number --jq '.[0].number // empty')

if [ "$status" = 0 ]; then
	if [ -n "$issue" ]; then
		gh issue close "$issue" --comment "Nothing needs a look any more. [Run]($RUN_URL)"
	fi
	exit 0
fi

if [ "$status" = 1 ]; then
	count=$(grep -oE '^### Needs a look \([0-9]+\)' "$report_file" | grep -oE '[0-9]+' || true)
	title="Model catalog check: ${count:-some} item(s) need a look"
	findings=$(cat "$report_file")
else
	title='Model catalog check could not run'
	findings=$(printf 'The check stopped with exit code %s:\n\n```\n%s\n```' "$status" "$(tail -n 40 "$error_file")")
fi

# A hash of the findings, kept in the issue body, tells whether they changed since the last run
hash=$(printf '%s' "$findings" | git hash-object --stdin | cut -c1-16)
footer="@$GITHUB_REPOSITORY_OWNER, from the weekly model catalog check. [Run]($RUN_URL)"
body=$(printf '%s\n\n%s\n\n<!-- findings: %s -->' "$findings" "$footer" "$hash")

if [ -z "$issue" ]; then
	gh label create "$label" --color FBCA04 --description 'Weekly model catalog check' --force > /dev/null
	gh issue create --title "$title" --label "$label" --body "$body"
elif ! gh issue view "$issue" --json body --jq .body | grep -qF "<!-- findings: $hash -->"; then
	# editing the body sends no e-mail, so the new findings also go in a comment
	gh issue edit "$issue" --title "$title" --body "$body"
	gh issue comment "$issue" --body "$(printf 'The findings changed:\n\n%s\n\n%s' "$findings" "$footer")"
fi
