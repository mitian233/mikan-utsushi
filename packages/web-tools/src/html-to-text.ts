const MAX_TEXT_CHARACTERS = 30_000;
const REMOVED_ELEMENTS = ["script", "style", "noscript", "template", "svg", "nav", "form"] as const;

export interface ReadWebResult {
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
  trust: "untrusted_web_content";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

async function sanitizeHtml(body: Uint8Array): Promise<string> {
  const rewriter = new HTMLRewriter();
  for (const elementName of REMOVED_ELEMENTS) {
    rewriter.on(elementName, {
      element(element) {
        element.remove();
      },
    });
  }
  return rewriter.transform(new Response(body.slice().buffer)).text();
}

async function extractHtmlTarget(body: Uint8Array, selector: string | null): Promise<string> {
  const sanitized = await sanitizeHtml(body);
  let text = "";
  const rewriter = new HTMLRewriter();
  if (selector) {
    rewriter.on(selector, {
      text(chunk) {
        text += chunk.text;
      },
    });
  } else {
    rewriter.onDocument({
      text(chunk) {
        text += chunk.text;
      },
    });
  }
  await rewriter.transform(new Response(sanitized)).arrayBuffer();
  return normalizeText(text);
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARACTERS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARACTERS), truncated: true };
}

export async function extractWebText(input: {
  url: string;
  contentType: string;
  body: Uint8Array;
}): Promise<ReadWebResult> {
  const contentType = input.contentType.toLowerCase();
  const mediaType = contentType.split(";", 1)[0]?.trim() ?? "";
  const isHtml = mediaType === "text/html" || mediaType === "application/xhtml+xml";
  let text: string;
  if (isHtml) {
    const article = await extractHtmlTarget(input.body, "article");
    const main = article ? "" : await extractHtmlTarget(input.body, "main");
    const body = article || main ? "" : await extractHtmlTarget(input.body, "body");
    text = article || main || body || await extractHtmlTarget(input.body, null);
  } else {
    text = normalizeText(new TextDecoder().decode(input.body));
  }
  const truncated = truncateText(text);
  return {
    url: input.url,
    contentType: input.contentType,
    text: truncated.text,
    truncated: truncated.truncated,
    trust: "untrusted_web_content",
  };
}
