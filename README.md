# Zyqen Technology — AI Mail Automator (Backend)

The Node.js and Express backend engine for **Zyqen Technology's** AI-powered candidate outreach and automated email sequence system.

## Key Features
- **AI Email Generation:** Uses Google Gemini (`gemini-2.5-flash`) to generate personalized 2-step initial outreach and follow-up drafts from candidate details (`Name`, `Email`, `Role`, `Skills`).
- **Automated Sequence Scheduler:** Runs a `node-cron` background worker every 10 seconds to dispatch due emails via Gmail SMTP (Nodemailer).
- **Smart Auto-Pause:** Automatically halts scheduled follow-ups when a candidate is marked as `Replied`.
- **Cloud Database:** Stores candidate profiles, AI drafts, and live sequence states in MongoDB Atlas.

## Tech Stack
- **Runtime & Framework:** Node.js, Express.js
- **Database:** MongoDB Atlas, Mongoose
- **AI & Automation:** Google Gemini API (`@google/genai`), Nodemailer, `node-cron`
