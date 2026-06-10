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

// Contract for when user manually supplies their income details.
// We still want the same output shape so the frontend never has to branch.
const MANUAL_CONTRACT = `
The user has manually provided their income details because the AI could not detect a regular salary from their bank statement.
Use ONLY the information they have provided — do not infer or invent anything else.
Return ONLY valid JSON (no markdown, no backticks) in EXACTLY this shape:

{
  "bank": "string or 'unknown'",
  "account_holder": "string or null",
  "statement_period": { "from": null, "to": null },

  "salary_detected": false,
  "income_manually_confirmed": true,
  "income_type": "salary | irregular_business | grant | mixed | unknown",
  "income": {
    "pay_dates": [],
    "frequency": "monthly | weekly | fortnightly | irregular | unknown",
    "typical_day_of_month": number or null,
    "average_amount": number or null,
    "currency": "ZAR"
  },

  "existing_debit_orders": [],

  "recommended_debit_date": {
    "day_of_month": number or null,
    "reason": "string — based on the pay day the user provided, explain why this debit date is best"
  },

  "affordability_note": "string — note that income was self-reported and could not be verified from the statement",
  "confidence": "low",
  "notes": "Income details were manually confirmed by the account holder."
}
`;

async function callMistral(messages) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: "mistral-small-latest",
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
    const body = req.body || {};

    // ── Manual confirmation path ────────────────────────────────────────────
    // When salary_detected was false and the user fills in their own details,
    // the frontend POSTs { manualConfirmation: true, manualData: { ... } }
    if (body.manualConfirmation) {
      const { manualData, bank, accountHolder } = body;
      if (!manualData) {
        return res.status(400).json({ error: "manualData is required for manual confirmation." });
      }

      const messages = [
        {
          role: "system",
          content: "You are a financial analysis assistant. " + MANUAL_CONTRACT,
        },
        {
          role: "user",
          content: [
            `Bank: ${bank || "unknown"}`,
            `Account holder: ${accountHolder || "unknown"}`,
            `Employment type: ${manualData.employmentType}`,
            `Pay frequency: ${manualData.frequency}`,
            `Pay day (day of month or description): ${manualData.payDay}`,
            `Approximate monthly income: ${manualData.amount} ZAR`,
          ].join("\n"),
        },
      ];

      const raw = await callMistral(messages);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      }

      // Preserve any bank/holder info we already have from the AI pass
      if (bank) parsed.bank = bank;
      if (accountHolder) parsed.account_holder = accountHolder;

      return res.status(200).json({ ok: true, result: parsed });
    }

    // ── Normal statement parse path ─────────────────────────────────────────
    const { fileType, fileName, content, password } = body;

    if (!fileType || !content) {
      return res.status(400).json({ error: "Send fileType ('csv' or 'pdf') and content." });
    }

    let textForModel = "";

    if (fileType === "csv") {
      textForModel = content;
    } else if (fileType === "pdf") {
      let pdfText;
      try {
        pdfText = await extractPdfText(content, password);
      } catch (e) {
        const msg = String(e.message || e).toLowerCase();
        if (msg.includes("password")) {
          if (!password) {
            return res.status(401).json({ needsPassword: true });
          }
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
      parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    }

    return res.status(200).json({ ok: true, result: parsed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

// --- PDF text extraction with optional password unlock ---
async function extractPdfText(base64, password) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const data = Buffer.from(base64, "base64");

  const pdf = await getDocumentProxy(new Uint8Array(data), {
    password: password || undefined,
  });
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
