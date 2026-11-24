// Markdown, as the AI writes answers and minutes, turned into formatted HTML
// for the meetings page and the panel, and copied as rich text so it pastes
// into Word, Teams or Outlook as real headings, lists, bold and tables
// (with clean plain text alongside for anywhere else).
(() => {
  const Earshot = (globalThis.Earshot ??= {});

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Inline: `code`, [text](url), [[wiki links]], **bold**, *italic*, _italic_, ~~strike~~.
  function inline(text) {
    const codes = [];
    let s = String(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = esc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
      .replace(/(^|[^*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_(?![\s_])(.+?)(?<![\s_])_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~(.+?)~~/g, "<s>$1</s>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
  }

  // Inline markup taken out, for plain text.
  const unmark = (text) =>
    String(text)
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => a ?? b)
      .replace(/(^|[^*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, "$1$2")
      .replace(/(^|[^\w])_(?![\s_])(.+?)(?<![\s_])_(?!\w)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1");

  const ITEM = /^(\s*)([-*+•]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/;
  const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const indentOf = (s) => s.replace(/\t/g, "  ").length;

  // Blocks: headings, paragraphs, nested lists (by indent), tables, quotes,
  // code fences and rules.
  function parse(md) {
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = /^\s*```/.exec(line);
      if (fence) {
        const body = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
        blocks.push({ type: "code", text: body.join("\n") });
        i++;
        continue;
      }
      const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        blocks.push({ type: "rule" });
        i++;
        continue;
      }
      if (line.includes("|") && TABLE_RULE.test(lines[i + 1] || "")) {
        const head = cells(line);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
        blocks.push({ type: "table", head, rows });
        continue;
      }
      if (/^\s*>/.test(line)) {
        const body = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""));
        blocks.push({ type: "quote", blocks: parse(body.join("\n")) });
        continue;
      }
      if (ITEM.test(line)) {
        const root = { lists: [] };
        const stack = [{ indent: -1, item: root }];
        let last = null;
        for (; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) {
            // A blank line inside a list only continues it if another item follows.
            const next = lines.slice(i + 1).find((x) => x.trim());
            if (next && ITEM.test(next)) continue;
            break;
          }
          const m = ITEM.exec(l);
          if (!m) {
            if (last && indentOf(/^\s*/.exec(l)[0]) > 0) {
              last.text += `\n${l.trim()}`;
              continue;
            }
            break;
          }
          const indent = indentOf(m[1]);
          while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
          const parent = stack[stack.length - 1].item;
          const ordered = /\d/.test(m[2]);
          let list = parent.lists[parent.lists.length - 1];
          if (!list || list.ordered !== ordered || list.closed) {
            list = { ordered, start: ordered ? parseInt(m[2], 10) : 1, items: [] };
            parent.lists.push(list);
          }
          last = { text: m[4], check: m[3] ? (/x/i.test(m[3]) ? "done" : "open") : null, lists: [] };
          list.items.push(last);
          stack.push({ indent, item: last });
        }
        blocks.push(...root.lists.map((list) => ({ type: "list", list })));
        continue;
      }
      // A paragraph runs until a blank line or another kind of block.
      const body = [line.trim()];
      for (i++; i < lines.length && lines[i].trim() && !ITEM.test(lines[i]) && !/^\s*(#{1,6}\s|>|```)/.test(lines[i]) && !(lines[i].includes("|") && TABLE_RULE.test(lines[i + 1] || "")); i++) body.push(lines[i].trim());
      blocks.push({ type: "para", lines: body });
    }
    return blocks;
  }

  // Word and Teams ignore stylesheets on paste, so copies carry inline styles.
  const COPY_STYLE = {
    table: "border-collapse:collapse;margin:6px 0",
    th: "border:1px solid #bfbfbf;padding:4px 8px;background:#f2f2f2;text-align:left",
    td: "border:1px solid #bfbfbf;padding:4px 8px;vertical-align:top",
    code: "font-family:Consolas,Menlo,monospace",
    quote: "border-left:3px solid #bfbfbf;margin:6px 0;padding-left:10px;color:#555",
  };

  function toHtml(blocks, copy) {
    const st = (name) => (copy ? ` style="${COPY_STYLE[name]}"` : "");
    const box = (check) => (check === "done" ? "☑ " : check === "open" ? "☐ " : "");
    const list = (l) => {
      const tag = l.ordered ? "ol" : "ul";
      const items = l.items.map((it) => `<li>${box(it.check)}${it.text.split("\n").map(inline).join("<br>")}${it.lists.map(list).join("")}</li>`).join("");
      return `<${tag}${l.ordered && l.start !== 1 ? ` start="${l.start}"` : ""}>${items}</${tag}>`;
    };
    return blocks
      .map((b) => {
        switch (b.type) {
          case "heading":
            return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
          case "rule":
            return "<hr>";
          case "code":
            return `<pre${st("code")}><code>${esc(b.text)}</code></pre>`;
          case "quote":
            return `<blockquote${st("quote")}>${toHtml(b.blocks, copy)}</blockquote>`;
          case "table":
            return `<table${st("table")}><thead><tr>${b.head.map((c) => `<th${st("th")}>${inline(c)}</th>`).join("")}</tr></thead><tbody>${b.rows
              .map((r) => `<tr>${b.head.map((_, k) => `<td${st("td")}>${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
              .join("")}</tbody></table>`;
          case "list":
            return list(b.list);
          default:
            return `<p>${b.lines.map(inline).join("<br>")}</p>`;
        }
      })
      .join("");
  }

  function toText(blocks, depth = 0) {
    const pad = "    ".repeat(depth);
    const box = (check) => (check === "done" ? "☑ " : check === "open" ? "☐ " : "");
    const list = (l, level) =>
      l.items
        .map((it, k) => {
          const mark = l.ordered ? `${l.start + k}.` : "•";
          const lead = `${pad}${"    ".repeat(level)}${mark} `;
          const text = it.text.split("\n").map(unmark).join(`\n${" ".repeat(lead.length)}`);
          return [`${lead}${box(it.check)}${text}`, ...it.lists.map((sub) => list(sub, level + 1))].join("\n");
        })
        .join("\n");
    return blocks
      .map((b) => {
        switch (b.type) {
          case "heading":
            return `${pad}${unmark(b.text)}`;
          case "rule":
            return `${pad}────────`;
          case "code":
            return b.text;
          case "quote":
            return toText(b.blocks, depth + 1);
          case "table":
            return [b.head, ...b.rows].map((r) => pad + r.map(unmark).join("\t")).join("\n");
          case "list":
            return list(b.list, 0);
          default:
            return b.lines.map((l) => pad + unmark(l)).join("\n");
        }
      })
      .join("\n\n");
  }

  Earshot.markdownToHtml = (md) => toHtml(parse(md), false);
  Earshot.markdownToText = (md) => toText(parse(md));

  // Copy as rich text (Word, Teams, Outlook) with plain text alongside.
  // A selection in the panel (transcript or an Ask AI answer) as plain text: a speaker's
  // name and time on a line of their own when it crosses speakers, paragraphs and list
  // items on their own lines, and none of the buttons, badges or captions in between.
  const BLOCK_TAGS = /^(DIV|P|LI|UL|OL|H[1-6]|TR|PRE|BLOCKQUOTE|TABLE|FIGURE)$/;
  const SKIP = ".reacts, .badge, .meta2, .cap, button, img";
  Earshot.selectionText = (range) => {
    const frag = range.cloneContents();
    for (const n of frag.querySelectorAll(SKIP)) n.remove();
    let out = "";
    const newline = () => {
      if (out && !out.endsWith("\n")) out += "\n";
    };
    const walk = (n) => {
      if (n.nodeType === 3) return void (out += n.nodeValue);
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.tagName === "BR") return void (out += "\n");
      if (n.classList?.contains("who")) {
        const name = n.querySelector(".name")?.textContent.trim();
        const when = n.querySelector(".when")?.textContent.trim();
        const label = [name, when && `[${when}]`].filter(Boolean).join(" ");
        if (!label) return;
        newline();
        if (out) out += "\n";
        out += `${label}\n`;
        return;
      }
      const block = n.nodeType === 1 && BLOCK_TAGS.test(n.tagName);
      if (block) newline();
      if (n.tagName === "LI") out += n.parentNode?.tagName === "OL" ? `${[...n.parentNode.children].indexOf(n) + 1}. ` : "- ";
      for (const c of n.childNodes) walk(c);
      if (block) newline();
    };
    walk(frag);
    return out
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };

  // Copies a selection: plain text, plus (rich) its formatting for Word and Teams.
  Earshot.copySelection = async (range, { rich = false } = {}) => {
    const text = Earshot.selectionText(range);
    if (rich) {
      const box = document.createElement("div");
      box.appendChild(range.cloneContents());
      for (const n of box.querySelectorAll(SKIP)) n.remove();
      const html = `<div style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt">${box.innerHTML}</div>`;
      try {
        return await navigator.clipboard.write([
          new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) }),
        ]);
      } catch {}
    }
    await navigator.clipboard.writeText(text);
  };

  Earshot.copyFormatted = async (md) => {
    const text = Earshot.markdownToText(md);
    const html = `<div style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt">${toHtml(parse(md), true)}</div>`;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) }),
      ]);
    } catch {
      await navigator.clipboard.writeText(text);
    }
  };
})();
