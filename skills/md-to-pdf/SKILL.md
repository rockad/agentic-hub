---
name: md-to-pdf
description: Convert Markdown documents to professionally styled PDFs using HTML/CSS templates and WeasyPrint. Supports custom templates, CSS stylesheets, YAML frontmatter variables, page-break hygiene, and print paged media (@page).
when_to_use: The user wants to convert a Markdown file (CV, resume, report, proposal, notes) to a PDF with professional HTML/CSS layout and styling. Keywords -- md to pdf, markdown to pdf, generate pdf, export pdf from markdown, cv pdf, resume pdf.
argument-hint: "<input.md> [-o output.pdf] [-t template.html] [-c style.css] [--var key=val]"
allowed-tools: Bash(bash *) Bash(uv run *) Bash(python3 *) Read
metadata:
  author: aleksandr
  requires: uv (for weasyprint + markdown + jinja2 + pyyaml execution)
---

# md-to-pdf

Converts Markdown documents into clean, professionally styled PDFs via HTML/CSS templates and `weasyprint`.

Designed for resumes/CVs, documentation exports, project proposals, and reports where default Markdown renderers look crude, lack page-break control, or break table layouts across pages.

## Features

- **CSS Paged Media (`@page`)**: Native support for page sizes (A4, Letter), margins, and automatic header/footer page counters (`counter(page) / counter(pages)`).
- **Page-Break Hygiene**: Pre-configured CSS rules preventing orphan headings (`page-break-after: avoid`), split list items, broken tables, or severed experience items.
- **Jinja2 Templating**: Supply any custom HTML layout. Markdown body is passed as `{{ content | safe }}`, and frontmatter fields (e.g. `{{ title }}`, `{{ date }}`, `{{ meta.name }}`) are directly accessible.
- **Relative Asset Resolution**: Resolves relative images (e.g. photos, company logos) relative to the source Markdown file.
- **Self-Contained Execution**: Runs via `uv run` with PEP 723 inline dependency metadata. No global virtualenv activation required.

## Usage

```bash
# Basic conversion with built-in clean modern template:
uv run "$SKILL_DIR/scripts/md_to_pdf.py" input.md -o output.pdf

# Using a custom Jinja2 HTML template:
uv run "$SKILL_DIR/scripts/md_to_pdf.py" input.md -t /path/to/template.html -o output.pdf

# Injecting an extra CSS stylesheet:
uv run "$SKILL_DIR/scripts/md_to_pdf.py" input.md -c /path/to/extra.css -o output.pdf

# Passing custom variables to the template:
uv run "$SKILL_DIR/scripts/md_to_pdf.py" input.md --var company="AlphaSense" --var role="Principal Engineer"
```

## Template Variables

When writing or using a custom template (`-t template.html`), the following variables are available in the Jinja2 context:

| Variable | Description |
|---|---|
| `{{ content }}` | The rendered Markdown body converted to HTML. Always use `{{ content \| safe }}`. |
| `{{ meta }}` | Dictionary containing all YAML frontmatter keys from the input document. |
| `{{ title }}` | Document title (from `meta.title`, first `# H1` heading, or input filename stem). |
| `{{ date }}` | Document date (from `meta.date` or current ISO date). |
| `{{ input_filename }}` | Name of the source `.md` file. |
| `{{ extra_css }}` | Injected CSS rules passed via `-c/--css`. |
| Custom vars | Any key passed via `--var key=value`. |
