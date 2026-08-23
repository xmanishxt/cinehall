#!/data/data/com.termux/files/usr/bin/python3
"""CineHall sitemap generator — catalog.json → public/sitemap.xml + robots.txt
Re-run whenever the catalog changes:  python3 gen-sitemap.py
"""
import json
import os
from urllib.parse import quote

BASE = "https://cinehall.in"
HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.join(HERE, "data", "catalog.json")
OUT = os.path.join(HERE, "public", "sitemap.xml")
ROBOTS = os.path.join(HERE, "public", "robots.txt")

# Static pages (all serve real HTML, verified 200)
STATIC = [
    ("/", "daily"),
    ("/dmca", "monthly"),
    ("/privacy", "monthly"),
    ("/terms", "monthly"),
]

def build_urls():
    with open(CATALOG, "r", encoding="utf-8") as f:
        data = json.load(f)

    seen = set()
    urls = []

    for group in ("movies", "tv", "anime", "top", "topDetailed"):
        for item in data.get(group, []):
            key = (item.get("type"), item.get("id"))
            if key[1] is None or key in seen:
                continue
            seen.add(key)
            urls.append((f"/watch/{item['type']}/{item['id']}", "weekly"))

    return urls + STATIC

def main():
    urls = build_urls()

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for path, freq in urls:
        lines.append("  <url>")
        lines.append(f"    <loc>{BASE}{quote(path)}</loc>")
        lines.append(f"    <changefreq>{freq}</changefreq>")
        lines.append("  </url>")
    lines.append("</urlset>")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    robots = (
        "User-agent: *\n"
        "Allow: /\n"
        "\n"
        f"Sitemap: {BASE}/sitemap.xml\n"
    )
    with open(ROBOTS, "w", encoding="utf-8") as f:
        f.write(robots)

    print(f"sitemap.xml → {len(urls)} URLs ({os.path.getsize(OUT)} bytes)")
    print(f"robots.txt → {len(robots)} bytes")

if __name__ == "__main__":
    main()