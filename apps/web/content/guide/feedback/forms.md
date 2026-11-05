---
title: Forms for structured feedback
part: feedback
order: 20
summary: Ask reviewers for labels, ratings, scores or a choice, and get their answers back as data.
requires: [forms]
sources: [packages/shared/src/forms.ts, packages/shared/src/forms-templates.ts, apps/api/src/forms.ts, apps/api/src/comments.ts, apps/cli/src/forms.ts, apps/cli/src/commands/forms.ts, apps/web/src/pages/Responses.tsx, apps/web/src/components/review/Forms.tsx, packages/shared/src/mcp-tools.ts]
verified: 60d6113
---

A form asks reviewers the same questions on each page: a verdict, a score from 1 to 5, A or B, a
severity. They pick from options on the [review page](/guide/feedback/comments) instead of typing
codes into comments, and you get their answers back as a table you can download.

A form comes in one of two kinds:

- **Per page**: each reviewer answers once per page, and can change their answer. Use it for
  labels, scores and comparisons.
- **A type of comment**: reviewers flag a passage and fill in the form about it, such as an issue
  with its severity.

A form can also be **blind**: each reviewer sees only their own answers, and the site's owners see
everyone's.

## In your assistant

- "Set up a form on `interviews` so reviewers label each page pass or fail, with notes. Keep it
  blind."
- "Add a rubric to `q3-report`: clarity and accuracy, scored 1 to 5."
- "How far have the reviewers got on `interviews`? Which pages are left?"
- "Summarise the labels on `interviews`."

The assistant asks what you want to collect, starts from a template, checks the form against the
site's pages and publishes it with the site.

## On the command line

A form lives in a file called `fling.forms.json` at the top of the folder you deploy. It is never
served as a file.

```sh
fling forms init ./dist --template labels --title Labels   # write a starter
fling forms check ./dist                                   # check it against the folder's pages
fling deploy ./dist                                        # publish the site with its forms
fling forms q3-report                                      # the forms the live site has
fling responses q3-report                                  # who answered which page
fling responses q3-report --format csv -o labels.csv       # the answers: json, jsonl or csv
```

The templates are `labels` (a verdict and notes per page, blind), `rubric` (criteria scored 1 to 5),
`compare` (A, B or a tie, and why), `issue` (a type of comment with severity and category) and
`survey` (questions answered once per page). Each form is a JSON Schema: edit the questions, the
options and the pages it applies to.

## In the web app

On the review page, a site with per-page forms shows a tab beside **Comments**, named after the
forms (such as **Labels**), with how many pages you have done. Answer and press **Save**, or **Save
and next** to move to the next page. A comment-type form appears as a choice when you write a
comment.

To see everyone's progress, open the link named after the forms (such as **Labels · 12 / 51**) on
the site's page. It shows each form as pages against reviewers, and downloads the answers as
**CSV** or **JSONL**.

## When it goes wrong

- **The deploy stops on the forms file**: `fling forms check` lists each error and where it is.
  Fix them and deploy again.
- **A form matches no pages**: its page patterns (`paths`) match none of the site's pages. Check
  them with `fling forms check`.
- **The forms disappeared**: deploying a whole site without `fling.forms.json` removes its forms.
  Put the file back and deploy again. A folder from `fling pull` keeps them.
- **A Path deploy is refused**: forms belong to the whole site. Deploy them with the site's own
  pages, using patterns such as `PAY-412/**` to reach a [Path](/guide/team-sites/paths)'s pages.

## Good to know

- Anyone who can comment on a site can answer its forms.
- A site can have up to {{fact:forms-max}} forms, and up to {{fact:responses-max}} answers.
- Taking a form away never reveals blind answers: they stay visible only to the people who wrote
  them and the site's owners.
