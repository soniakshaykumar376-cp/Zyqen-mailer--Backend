require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Connect to MongoDB Atlas
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully'))
  .catch((err) => console.error('❌ MongoDB Connection Error:', err.message));

// 2. Setup Gemini AI & Gmail Transporter
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 3. Database Blueprint (Schema) for Each Candidate
const candidateSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    role: String,
    skills: String,
    step1Subject: String,
    step1Body: String,
    step2Subject: String,
    step2Body: String,
    status: { type: String, default: 'Draft' }, // Draft, Active, Replied, Completed
    currentStep: { type: Number, default: 0 }, // 0 = Draft, 1 = Step 1 due, 2 = Step 2 due, 3 = Done
    demoMode: { type: Boolean, default: true },
    nextSendAt: { type: Date, default: null },
    lastLog: { type: String, default: 'AI draft ready' },
  },
  { timestamps: true }
);

const Candidate = mongoose.model('Candidate', candidateSchema);

// 4. API Routes

// Get all candidates for the dashboard
app.get('/api/candidates', async (req, res) => {
  try {
    const list = await Candidate.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload CSV rows & generate personalized AI drafts
app.post('/api/generate-drafts', async (req, res) => {
  const { candidates, campaignContext } = req.body;
  if (!candidates || !candidates.length) {
    return res.status(400).json({ error: 'No candidates provided' });
  }

  const savedCandidates = [];

  for (const c of candidates) {
    const name = c.Name || c.name || 'Candidate';
    const email = (c.Email || c.email || '').trim();
    const role = c.Role || c.role || 'Software Developer';
    const skills = c.Skills || c.skills || 'Web Development';

    if (!email) continue;

    let drafts = {
      step1Subject: `Opportunity at Zyqen Technology — ${role}`,
      step1Body: `Hi ${name},\n\nWe came across your profile and loved your background in ${skills}. At Zyqen Technology, we are looking for a ${role} and would love to connect.\n\nBest regards,\nHiring Team, Zyqen Technology`,
      step2Subject: `Quick follow-up: ${role} at Zyqen Technology`,
      step2Body: `Hi ${name},\n\nJust following up on my previous note regarding the ${role} role at Zyqen Technology. Let us know if you're open to a quick chat!\n\nBest,\nZyqen Technology`,
    };

    try {
      const prompt = `You are a recruiter at Zyqen Technology. Write a 2-step personalized outreach email sequence for this candidate:
- Name: ${name}
- Target Role: ${role}
- Skills: ${skills}
- Campaign Context: ${campaignContext || 'Hiring talented developers for Zyqen Technology'}

Return ONLY a valid JSON object with exact keys:
{
  "step1Subject": "short catchy subject line",
  "step1Body": "personalized initial email (under 90 words, warm and professional, signed Zyqen Technology)",
  "step2Subject": "polite follow-up subject line",
  "step2Body": "short follow-up email sent a few days later if no reply (under 60 words, signed Zyqen Technology)"
}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });

      const cleanJson = response.text.replace(/```json|```/g, '').trim();
      drafts = JSON.parse(cleanJson);
    } catch (aiErr) {
      console.error(`⚠️ Gemini fallback used for ${email}:`, aiErr.message);
    }

    const created = await Candidate.create({
      name,
      email,
      role,
      skills,
      ...drafts,
      status: 'Draft',
      currentStep: 0,
      lastLog: 'AI draft generated',
    });

    savedCandidates.push(created);
  }

  res.json(savedCandidates);
});

// Edit a candidate's AI-generated email text before sending
app.put('/api/candidates/:id', async (req, res) => {
  try {
    const updated = await Candidate.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Launch the automated sequence for all Draft candidates
app.post('/api/launch', async (req, res) => {
  const { demoMode } = req.body;
  try {
    await Candidate.updateMany(
      { status: 'Draft' },
      {
        $set: {
          status: 'Active',
          currentStep: 1,
          demoMode: Boolean(demoMode),
          nextSendAt: new Date(), // Send Step 1 immediately
          lastLog: 'Queued for Step 1...',
        },
      }
    );
    res.json({ message: 'Sequence launched!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark candidate as Replied (Auto-pauses follow-up emails)
app.post('/api/candidates/:id/reply', async (req, res) => {
  try {
    const updated = await Candidate.findByIdAndUpdate(
      req.params.id,
      {
        status: 'Replied',
        nextSendAt: null,
        lastLog: `Replied at ${new Date().toLocaleTimeString()} — Sequence Paused`,
      },
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all candidates (reset for fresh demo)
app.delete('/api/candidates', async (req, res) => {
  try {
    await Candidate.deleteMany({});
    res.json({ message: 'All candidates cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Background Sequence Scheduler (Checks every 10 seconds)
cron.schedule('*/10 * * * * *', async () => {
  try {
    const dueCandidates = await Candidate.find({
      status: 'Active',
      nextSendAt: { $lte: new Date() },
    });

    for (const candidate of dueCandidates) {
      if (candidate.currentStep === 1) {
        // Send Initial Email (Step 1)
        await transporter.sendMail({
          from: `"Zyqen Technology" <${process.env.EMAIL_USER}>`,
          to: candidate.email,
          subject: candidate.step1Subject,
          text: candidate.step1Body,
        });

        // Schedule Follow-up (30 seconds in Demo Mode, 3 days in Real Mode)
        const delayMs = candidate.demoMode ? 30 * 1000 : 3 * 24 * 60 * 60 * 1000;
        candidate.currentStep = 2;
        candidate.nextSendAt = new Date(Date.now() + delayMs);
        candidate.lastLog = `Step 1 sent (${new Date().toLocaleTimeString()}) — Follow-up scheduled`;
        await candidate.save();
        console.log(`📧 Step 1 sent to ${candidate.email}`);
      } else if (candidate.currentStep === 2) {
        // Send Follow-Up Email (Step 2)
        await transporter.sendMail({
          from: `"Zyqen Technology" <${process.env.EMAIL_USER}>`,
          to: candidate.email,
          subject: candidate.step2Subject,
          text: candidate.step2Body,
        });

        candidate.currentStep = 3;
        candidate.status = 'Completed';
        candidate.nextSendAt = null;
        candidate.lastLog = `Step 2 follow-up sent (${new Date().toLocaleTimeString()}) — Completed`;
        await candidate.save();
        console.log(`📧 Step 2 follow-up sent to ${candidate.email}`);
      }
    }
  } catch (err) {
    console.error('❌ Scheduler Error:', err.message);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Zyqen Backend running on http://localhost:${PORT}`));