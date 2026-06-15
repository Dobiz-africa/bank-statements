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
  "primary_income_source": "string — name or description of the likely employer/payer, or null",
  "income": {
    "pay_dates": ["YYYY-MM-DD", "..."],
    "frequency": "monthly | weekly | fortnightly | irregular | unknown",
    "typical_day_of_month": number or null,
    "average_amount": number or null,
    "currency": "string, e.g. ZAR or BWP"
  },

  "debit_orders": [
    {
      "description": "string — name of the debit order e.g. Capfin, Capfuneral, DStv",
      "amount": number,
      "typical_date": number or null,
      "status": "active | bounced | unknown"
    }
  ],

  "recommended_debit_date": {
    "day_of_month": number or null,
    "reason": "string — plain English explanation"
  },

  "affordability_note": "string — short plain-English read on income stability and ability to afford a new debit order",
  "confidence": "high | medium | low",
  "notes": "string — anything important the reviewer should know"
}

Rules:
- PRIMARY INCOME: Look for any company or person that sends money R2,000+ at least TWICE in the statement period. That source IS the primary income, even if amounts vary month to month and even if the money gets transferred out shortly after. The fact that money comes in from the same source repeatedly = income.
- If Ownisha Network, an employer, a company, or any single entity sends large amounts (R2,000+) 2 or more times → salary_detected=true, income_type="salary", set primary_income_source to that entity name.
- Calculate average_amount from those recurring deposits only. Set typical_day_of_month to the most common day those deposits arrive.
- IGNORE: small misc payments under R500 from many different people, internal transfers between the person's own accounts, refunds.
- List ALL debit orders — DebiCheck, EFT, scheduled payments, card subscriptions. Mark bounced ones as "bounced".
- Base recommended_debit_date on 1-2 days AFTER the typical income arrival day.
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
      model: "mistral-large-latest", // large model for better income pattern detection
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
      const pdfText = await extractPdfText(content, password);
      if (!pdfText || pdfText.trim().length < 20) {
        return res.status(422).json({
          error:
            "Could not read text from this PDF. It may be a scanned image. Ask the client to download the PDF directly from their banking app, or upload the CSV instead.",
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
// Uses unpdf — serverless-safe, no worker required, handles locked and unlocked PDFs.
async function extractPdfText(base64, password) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const data = Buffer.from(base64, "base64");

  const pdf = await getDocumentProxy(new Uint8Array(data), {
    password: password || undefined,
  });
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
