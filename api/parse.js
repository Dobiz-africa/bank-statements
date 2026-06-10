// api/parse.js — Vercel serverless function
// Accepts a bank statement as CSV or PDF, sends it to Mistral,
// and returns ONE consistent JSON shape regardless of bank or file type.
//
// Two outputs the tool must always give (per the brief):
//   1. When does salary/income get paid (dates + frequency)
//   2. Best date to run a debit order to collect money
//
// The Mistral API key lives here on the server, never in the browser.
// Set it in Vercel: Project Settings -> Environment Variables -> MISTRAL_API_KEY

export const config = {
  api: { bodyParser: { sizeLimit: "15mb" } },
};

// The exact JSON shape we always want back. Sent to Mistral as the contract.
const OUTPUT_CONTRACT = `
Return ONLY valid JSON (no markdown, no backticks, no commentary) in EXACTLY this shape:

{
  "bank": "string — bank name if identifiable, else 'unknown'",
  "account_holder": "string or null",
  "statement_period": { "from": "YYYY-MM-DD or null", "to": "YYYY-MM-DD or null" },

  "salary_detected": true/false,
  "income_type": "salary | irregular_business | grant | mixed | unknown",
  "income": {
    "pay_dates": ["YYYY-MM-DD", "..."],      // actual dates money came IN that look like income
    "frequency": "monthly | weekly | fortnightly | irregular | unknown",
    "typical_day_of_month": number or null,   // e.g. 25 if paid around the 25th
    "average_amount": number or null,
    "currency": "string, e.g. ZAR"
  },

  "existing_debit_orders": [
    { "description": "string", "amount": number, "day_of_month": number or null }
  ],

  "recommended_debit_date": {
    "day_of_month": number or null,
    "reason": "string — short plain-English why this day is safest to collect"
  },

  "affordability_note": "string — short plain-English read on income stability / risk",
  "confidence": "high | medium | low",
  "notes": "string — anything unusual the next team should know"
}

Rules:
- If there is no salary (e.g. a business account with many small irregular deposits),
  set salary_detected=false and income_type accordingly. Do NOT invent a salary date.
- Base recommended_debit_date on when money reliably arrives and before it gets spent.
- Use the statement's own currency.
`;

async function callMistral(messages) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: "mistral-small-latest", // cheap + good enough for extraction; swap to mistral-large-latest if needed
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Mistral API ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "{}";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }
  if (!process.env.MISTRAL_API_KEY) {
    return res.status(500).json({ error: "MISTRAL_API_KEY is not set on the server." });
  }

  try {
    // Body: { fileType: "csv" | "pdf", fileName, content }
    //   csv -> content is plain text
    //   pdf -> content is base64 (already unlocked client-side OR we unlock here)
    const { fileType, fileName, content, password } = req.body || {};

    if (!fileType || !content) {
      return res.status(400).json({ error: "Send fileType ('csv' or 'pdf') and content." });
    }

    let textForModel = "";

    if (fileType === "csv") {
      // CSV path — cleanest. Just hand the rows to the model to normalise.
      textForModel = content;
    } else if (fileType === "pdf") {
      // PDF path — extract text (unlocking with password if supplied), then send text.
      let pdfText;
      try {
        pdfText = await extractPdfText(content, password);
      } catch (e) {
        const msg = String(e.message || e).toLowerCase();
        // pdfjs/unpdf signal a password issue via these messages.
        if (msg.includes("password")) {
          if (!password) {
            // No password was given but the PDF needs one → tell the page to ask.
            return res.status(401).json({ needsPassword: true });
          }
          // A password was given but it was wrong.
          return res.status(401).json({ needsPassword: true, wrongPassword: true });
        }
        throw e;
      }

      if (!pdfText || pdfText.trim().length < 20) {
        return res.status(422).json({
          error:
            "Couldn't read any text from this PDF — it may be a scanned image rather than a digital statement. Please upload the statement downloaded directly from the banking app, or a CSV.",
        });
      }
      textForModel = pdfText;
    } else {
      return res.status(400).json({ error: "fileType must be 'csv' or 'pdf'." });
    }

    const messages = [
      {
        role: "system",
        content:
          "You read bank statements from any bank and extract a consistent structured summary. " +
          OUTPUT_CONTRACT,
      },
      {
        role: "user",
        content: `File name: ${fileName || "statement"}\nFile type: ${fileType}\n\nStatement content:\n${textForModel}`,
      },
    ];

    const raw = await callMistral(messages);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Last-ditch: strip any stray fences and retry
      parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    }

    return res.status(200).json({ ok: true, result: parsed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

// --- PDF text extraction with optional password unlock ---
// Uses unpdf — built for serverless/Node, no worker setup, handles
// both locked and unlocked PDFs. Throws an error containing "password"
// when the PDF is encrypted and the password is missing or wrong.
async function extractPdfText(base64, password) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const data = Buffer.from(base64, "base64");

  const pdf = await getDocumentProxy(new Uint8Array(data), {
    password: password || undefined,
  });
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
