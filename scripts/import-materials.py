#!/usr/bin/env python3
"""Import the user-provided PDF and the specified idiom table, offline at runtime.

Requires Python 3.10+ and Poppler's pdftotext; no Python packages are required.
The HTML is input data only. Scripts and other article content are never copied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

IDIOMS_URL = "https://ukaru-eigo.com/jukugo-target-1000-list/"
ROOT = Path(__file__).resolve().parents[1]


def check_entries(entries: list[dict], count: int, prefix: str) -> list[dict]:
    """A missing, repeated, reordered or empty entry must fail the import."""
    if len(entries) != count:
        raise ValueError(f"Expected {count} entries, found {len(entries)}")
    for number, entry in enumerate(entries, start=1):
        if entry["number"] != number or entry["id"] != f"{prefix}-{number:04d}":
            raise ValueError(f"Missing, duplicate or reordered entry near {number}")
        for field in ("english", "japanese"):
            text = entry[field]
            if not isinstance(text, str) or not text.strip() or "\ufffd" in text:
                raise ValueError(f"Empty or undecodable {field} at entry {number}")
            if any(ord(char) < 32 for char in text):
                raise ValueError(f"Unexpected control character at entry {number}")
    return entries


def parse_vocabulary(text: str) -> list[dict]:
    entries = []
    for line in text.splitlines():
        # Every source headword is one token. Splitting at the first token also
        # handles the two long words whose columns have only one separating space.
        matched = re.match(r"^\s*(\d{1,4})\s+(\S+)\s+(.+?)\s*$", line)
        if not matched:
            if line.strip() and not (
                "英単語ターゲット1900" in line
                or "No." in line
                or re.fullmatch(r"\s*\d+/38\s*", line)
            ):
                raise ValueError("Unrecognized PDF text line; inspect the source layout")
            continue
        number, english, japanese = matched.groups()
        if not re.fullmatch(r"[A-Za-z][A-Za-z'’\-]*", english):
            raise ValueError(f"Unexpected headword at entry {number}")
        number = int(number)
        entries.append({
            "id": f"v1900-{number:04d}",
            "number": number,
            "english": english,
            "japanese": japanese.strip(),
        })
    return check_entries(entries, 1900, "v1900")


class TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.cells = None
        self.current = None
        self.rows = []

    def handle_starttag(self, tag: str, attrs: list[tuple]) -> None:
        if tag == "table":
            self.depth += 1
        elif self.depth and tag == "tr":
            self.cells = []
        elif self.depth and tag in ("td", "th"):
            self.current = []
        elif self.current is not None and tag == "br":
            self.current.append(" ")

    def handle_data(self, data: str) -> None:
        if self.depth and self.current is not None:
            self.current.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self.current is not None:
            if self.cells is not None:
                self.cells.append(" ".join("".join(self.current).split()))
            self.current = None
        elif tag == "tr" and self.cells is not None:
            self.rows.append(self.cells)
            self.cells = None
        elif tag == "table":
            self.depth = max(0, self.depth - 1)


def parse_idioms(html: str) -> list[dict]:
    parser = TableParser()
    parser.feed(html)
    entries = []
    for row in parser.rows:
        if not row or not re.fullmatch(r"\d{1,4}", row[0]):
            continue  # The table header is not a learning entry.
        if len(row) != 3:
            raise ValueError("Unexpected number of cells in an idiom entry")
        number = int(row[0])
        entries.append({
            "id": f"i1000-{number:04d}",
            "number": number,
            "english": row[1],
            "japanese": row[2],
        })
    return check_entries(entries, 1000, "i1000")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, type=Path,
                        help="User-provided English_Vocabulary_Target_1900.pdf")
    parser.add_argument("--idioms-html", type=Path,
                        help="Previously downloaded HTML; omit to fetch the specified URL")
    parser.add_argument("--output", type=Path, default=ROOT / "data")
    args = parser.parse_args()

    pdf_bytes = args.pdf.read_bytes()
    pdf_text = subprocess.run(
        ["pdftotext", "-layout", "-enc", "UTF-8", str(args.pdf), "-"],
        check=True, capture_output=True,
    ).stdout.decode("utf-8", errors="strict")
    if args.idioms_html:
        html_bytes = args.idioms_html.read_bytes()
    else:
        request = urllib.request.Request(IDIOMS_URL, headers={
            "User-Agent": "Target-study-material-import/1.0"
        })
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise ValueError("Could not fetch the specified idiom list")
            html_bytes = response.read(5 * 1024 * 1024 + 1)
        if len(html_bytes) > 5 * 1024 * 1024:
            raise ValueError("Source HTML exceeds the import limit")

    # Validate both complete sources before replacing either output file.
    vocabulary = parse_vocabulary(pdf_text)
    idioms = parse_idioms(html_bytes.decode("utf-8", errors="strict"))
    args.output.mkdir(parents=True, exist_ok=True)
    for filename, entries in (("target1900.json", vocabulary), ("target1000.json", idioms)):
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.output,
                                         delete=False) as stream:
            json.dump(entries, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            temporary = Path(stream.name)
        temporary.replace(args.output / filename)

    print(json.dumps({
        "vocabulary": len(vocabulary), "idioms": len(idioms),
        "pdfSha256": hashlib.sha256(pdf_bytes).hexdigest(),
        "idiomHtmlSha256": hashlib.sha256(html_bytes).hexdigest(),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
