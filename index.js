const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
console.log("Checking API Key:", process.env.GEMINI_API_KEY ? "KEY IS LOADED!" : "KEY IS MISSING!");

const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/api/generate-quiz', upload.single('pastPaper'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

        // Configure the AI
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: { responseMimeType: "application/json" }
        });

        // NEW WAY: We package the raw PDF file directly for Gemini
        const pdfPart = {
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: "application/pdf"
            }
        };

        const prompt = `
        You are an expert university tutor. Generate exactly 5 multiple-choice questions based on the core concepts in the attached document.
        Return the response as a pure JSON array of objects using this exact schema:
        {
          "question": "The question text",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "correctAnswer": "The exact string of the correct option",
          "explanation": "A brief, 1-sentence explanation of why this is correct."
        }
        `;

        // We send BOTH the prompt and the PDF file directly to the AI
        const result = await model.generateContent([prompt, pdfPart]);
        const quizData = JSON.parse(result.response.text());
        
        res.json({ success: true, quiz: quizData });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: 'Failed to process document. ' + error.message });
    }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));