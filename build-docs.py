import markdown, html, pathlib
BM = "/sessions/gallant-affectionate-volta/mnt/InditressD2C/Inditress/01-Working/brand-memory"
OUT = "public/docs"
DOCS = [
    ("19-verbal-identity.md", "verbal-identity.html", "Doc 19", "Verbal Identity", "Brand voice, tagline & master narrative"),
    ("20-its-transparency-standard.md", "transparency-standard.html", "Doc 20", "ITS™ Transparency Standard", "The Chain of Trust — what we prove, batch by batch"),
]
SHELL = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Inditress</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@200;300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{{--ivory:#FAF6EE;--bone:#F5F1E9;--ink:#1A1A1A;--ink-60:rgba(26,26,26,.60);--ink-40:rgba(26,26,26,.40);--line:rgba(26,26,26,.12);--saffron:#D67D2E}}
*{{box-sizing:border-box}}
body{{margin:0;font-family:'Manrope',Inter,"Helvetica Neue",Helvetica,Arial,sans-serif;background:var(--ivory);color:var(--ink);font-weight:400;line-height:1.6;-webkit-font-smoothing:antialiased}}
.bar{{background:var(--bone);border-bottom:1px solid var(--line);padding:16px 26px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:5}}
.brand{{font-weight:500;letter-spacing:.34em;font-size:14px}}
.brand small{{display:block;font-weight:400;letter-spacing:.16em;color:var(--ink-60);font-size:9px;margin-top:4px;text-transform:uppercase}}
.dots{{display:flex;gap:6px;margin-left:auto}}.dots i{{width:6px;height:6px;border-radius:50%;background:var(--saffron)}}
.back{{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-60);text-decoration:none}}.back:hover{{color:var(--saffron)}}
.wrap{{max-width:760px;margin:0 auto;padding:48px 26px 90px}}
.eyebrow{{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--saffron);font-weight:600;margin-bottom:10px}}
.doc h1{{font-size:38px;font-weight:500;letter-spacing:-.02em;line-height:1.15;margin:.2em 0 .1em}}
.lede{{font-size:17px;color:var(--ink-60);margin:0 0 36px;padding-bottom:24px;border-bottom:1px solid var(--line)}}
.doc h2{{font-size:24px;font-weight:500;letter-spacing:-.01em;margin:2em 0 .5em}}
.doc h3{{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-60);margin:1.8em 0 .4em}}
.doc h4{{font-size:15px;font-weight:600;margin:1.4em 0 .3em}}
.doc p,.doc li{{font-size:16px}}
.doc a{{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--saffron)}}
.doc blockquote{{margin:1.2em 0;padding:.4em 0 .4em 20px;border-left:3px solid var(--saffron);color:var(--ink);font-size:17px}}
.doc code{{background:var(--bone);padding:1px 6px;border-radius:4px;font-size:.9em}}
.doc pre{{background:var(--bone);border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto;font-size:13px;line-height:1.5}}
.doc pre code{{background:none;padding:0}}
.doc table{{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:14px}}
.doc th,.doc td{{border:1px solid var(--line);padding:8px 11px;text-align:left;vertical-align:top}}
.doc th{{background:var(--bone);font-weight:600}}
.doc hr{{border:none;border-top:1px solid var(--line);margin:2.4em 0}}
.doc strong{{font-weight:600}}
</style></head><body>
<div class="bar"><div class="brand">INDITRESS<small>The Honest Hair Company</small></div>
<a class="back" href="/">&larr; Board</a><div class="dots"><i></i><i></i><i></i><i></i><i></i></div></div>
<div class="wrap"><div class="eyebrow">{eyebrow} · Brand Memory</div>
<div class="doc"><h1>{h1}</h1><p class="lede">{lede}</p>{body}</div></div>
</body></html>"""
for src, out, eyebrow, h1, lede in DOCS:
    md = pathlib.Path(BM, src).read_text(encoding="utf-8")
    # drop the first H1 line (we render our own title)
    lines = md.split("\n")
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    body = markdown.markdown("\n".join(lines), extensions=["tables","fenced_code","sane_lists"])
    page = SHELL.format(title=h1, eyebrow=eyebrow, h1=html.escape(h1), lede=html.escape(lede), body=body)
    pathlib.Path(OUT, out).write_text(page, encoding="utf-8")
    print("wrote", out, len(page), "bytes")
