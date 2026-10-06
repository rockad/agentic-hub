#!/usr/bin/env python3
"""
Convert Markdown documents to PDF using Jinja2/HTML templates and WeasyPrint.
"""

# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "markdown>=3.6",
#     "pyyaml>=6.0",
#     "jinja2>=3.1",
#     "weasyprint>=61.0",
# ]
# ///

import argparse
import datetime
import os
import re
import sys
from pathlib import Path

import jinja2
import markdown
import yaml
import weasyprint


def parse_frontmatter(text: str):
    """
    Extract YAML frontmatter if present at the top of the file.
    Returns (meta_dict, body_text).
    """
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            try:
                meta = yaml.safe_load(parts[1]) or {}
                body = parts[2].lstrip("\r\n")
                if isinstance(meta, dict):
                    return meta, body
            except Exception as e:
                print(f"[warning] Failed to parse YAML frontmatter: {e}", file=sys.stderr)
    return {}, text


def extract_title(body: str, meta: dict, default_name: str) -> str:
    """Extract document title from metadata or first H1 heading."""
    if "title" in meta and meta["title"]:
        return str(meta["title"])
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return default_name


def convert_markdown_to_html(md_text: str) -> str:
    """Convert Markdown to HTML with modern extensions."""
    md = markdown.Markdown(
        extensions=[
            "extra",
            "tables",
            "fenced_code",
            "attr_list",
            "def_list",
            "sane_lists",
            "toc",
        ]
    )
    return md.convert(md_text)


def load_template(template_path: Path | None, default_dir: Path) -> jinja2.Template:
    """Load specified Jinja2 template or fallback to default."""
    if template_path and template_path.exists():
        template_dir = template_path.parent
        template_name = template_path.name
        env = jinja2.Environment(
            loader=jinja2.FileSystemLoader(str(template_dir)),
            autoescape=jinja2.select_autoescape(["html", "xml"]),
        )
        return env.get_template(template_name)

    default_template_path = default_dir / "templates" / "default.html"
    if default_template_path.exists():
        env = jinja2.Environment(
            loader=jinja2.FileSystemLoader(str(default_dir / "templates")),
            autoescape=jinja2.select_autoescape(["html", "xml"]),
        )
        return env.get_template("default.html")

    # Fallback minimal inline template if default.html not found
    fallback_html = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{{ title }}</title>
<style>
@page { size: A4; margin: 20mm; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1f2937; }
h1, h2, h3 { color: #111827; page-break-after: avoid; }
h1 { font-size: 20pt; margin-top: 0; }
h2 { font-size: 14pt; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; margin-top: 18px; }
h3 { font-size: 11pt; margin-top: 12px; }
p, li { margin: 0 0 6px 0; }
ul, ol { padding-left: 20px; }
li { page-break-inside: avoid; }
a { color: #2563eb; text-decoration: none; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; }
th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
th { background: #f9fafb; font-weight: 600; }
</style>
</head>
<body>
{{ content | safe }}
</body>
</html>"""
    return jinja2.Template(fallback_html)


def main():
    parser = argparse.ArgumentParser(
        description="Convert Markdown to PDF using Jinja2/HTML templates and WeasyPrint."
    )
    parser.add_argument("input", help="Path to input Markdown file")
    parser.add_argument(
        "-o", "--output", help="Path to output PDF (defaults to <input_stem>.pdf)"
    )
    parser.add_argument(
        "-t", "--template", help="Path to custom HTML Jinja2 template file"
    )
    parser.add_argument(
        "-c", "--css", action="append", default=[], help="Path to extra CSS file(s) to inject"
    )
    parser.add_argument(
        "--base-url",
        help="Base directory for resolving relative URLs/images (default: input file's directory)",
    )
    parser.add_argument(
        "--var",
        action="append",
        default=[],
        help="Custom variable to pass to template in key=value format (repeatable)",
    )

    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    if not input_path.exists():
        print(f"Error: Input file does not exist: {input_path}", file=sys.stderr)
        sys.exit(1)

    output_path = (
        Path(args.output).resolve()
        if args.output
        else input_path.with_suffix(".pdf")
    )

    base_url = (
        Path(args.base_url).resolve()
        if args.base_url
        else input_path.parent
    )

    script_dir = Path(__file__).parent.resolve()
    skill_dir = script_dir.parent

    # Parse template variables
    custom_vars = {}
    for item in args.var:
        if "=" in item:
            k, v = item.split("=", 1)
            custom_vars[k.strip()] = v.strip()

    # Read markdown and parse frontmatter
    raw_text = input_path.read_text(encoding="utf-8")
    meta, body_text = parse_frontmatter(raw_text)

    # Convert markdown body to HTML
    body_html = convert_markdown_to_html(body_text)

    # Determine title
    title = extract_title(body_text, meta, input_path.stem)

    # Resolve template
    template_path = Path(args.template).resolve() if args.template else None
    template = load_template(template_path, skill_dir)

    # Extra CSS files
    extra_styles = []
    for css_file in args.css:
        cp = Path(css_file).resolve()
        if cp.exists():
            extra_styles.append(cp.read_text(encoding="utf-8"))
        else:
            print(f"[warning] CSS file not found: {cp}", file=sys.stderr)

    # Prepare Jinja2 context
    context = {
        "content": body_html,
        "meta": meta,
        "title": title,
        "date": meta.get("date", datetime.date.today().isoformat()),
        "input_filename": input_path.name,
        "extra_css": "\n".join(extra_styles),
        **custom_vars,
    }

    # Render template
    rendered_html = template.render(**context)

    # If extra CSS was provided and template didn't have {{ extra_css }}, inject it
    if extra_styles and "{{ extra_css }}" not in (template_path.read_text(encoding="utf-8") if template_path and template_path.exists() else ""):
        style_block = f"<style>\n{chr(10).join(extra_styles)}\n</style>\n"
        if "</head>" in rendered_html:
            rendered_html = rendered_html.replace("</head>", f"{style_block}</head>")
        else:
            rendered_html = style_block + rendered_html

    # Ensure output parent directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write PDF with WeasyPrint
    try:
        html = weasyprint.HTML(string=rendered_html, base_url=str(base_url))
        doc = html.render()
        doc.write_pdf(target=str(output_path))
        num_pages = len(doc.pages)
        size_kb = output_path.stat().st_size / 1024
        print(f"✓ Generated PDF: {output_path} ({size_kb:.1f} KB, {num_pages} pages)")
    except Exception as e:
        print(f"Error generating PDF via WeasyPrint: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
