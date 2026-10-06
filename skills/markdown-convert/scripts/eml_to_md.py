import sys
import email
import email.policy
import subprocess

def get_body(msg):
    plain, html = None, None
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition", ""))
            if "attachment" in disp:
                continue
            if ctype == "text/plain" and plain is None:
                plain = part.get_content()
            elif ctype == "text/html" and html is None:
                html = part.get_content()
    else:
        ctype = msg.get_content_type()
        if ctype == "text/html":
            html = msg.get_content()
        else:
            plain = msg.get_content()
    return plain, html

def get_attachments(msg):
    names = []
    if msg.is_multipart():
        for part in msg.walk():
            disp = str(part.get("Content-Disposition", ""))
            if "attachment" in disp:
                fn = part.get_filename()
                if fn:
                    names.append(fn)
    return names

def html_to_md(html):
    result = subprocess.run(
        ["markitdown"], input=html, capture_output=True, text=True
    )
    return result.stdout.strip()

def main(eml_path, out_path):
    with open(eml_path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=email.policy.default)

    headers = []
    for h in ["From", "To", "Cc", "Subject", "Date"]:
        v = msg.get(h)
        if v:
            headers.append(f"**{h}:** {v}")

    plain, html = get_body(msg)
    if plain:
        body = plain.strip()
    elif html:
        body = html_to_md(html)
    else:
        body = "*(no body content)*"

    attachments = get_attachments(msg)

    parts = ["\n".join(headers), "", "---", "", body]
    if attachments:
        parts += ["", "---", "", "**Attachments:**"] + [f"- {a}" for a in attachments]

    with open(out_path, "w") as f:
        f.write("\n".join(parts) + "\n")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
