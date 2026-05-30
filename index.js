const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const mammoth = require('mammoth');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 1. AUTHENTICATION ---
app.post('/api/login', async (req, res) => {
    const { googleId, name } = req.body;
    try {
        const { data, error } = await supabase.from('users').upsert([{ google_id: googleId, display_name: name }], { onConflict: 'google_id' }).select('id, display_name, total_xp, role').single();
        if (error) throw error; res.json({ success: true, user: data });
    } catch (e) { res.status(500).json({ error: 'Database error' }); }
});

app.post('/api/register', async (req, res) => {
    const { email, password, name } = req.body;
    try {
        const { data, error } = await supabase.from('users').insert([{ email, password, display_name: name, role: 'student' }]).select('id, display_name, total_xp, role').single();
        if (error) throw error; res.json({ success: true, user: data });
    } catch (e) { res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/email-login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data, error } = await supabase.from('users').select('id, display_name, total_xp, role').eq('email', email).eq('password', password).single();
        if (error || !data) return res.status(401).json({ error: 'Invalid login' });
        res.json({ success: true, user: data });
    } catch (e) { res.status(500).json({ error: 'Login failed' }); }
});

// --- 2. CONTEXTUAL QUIZZES & AI TUTOR ---
app.post('/api/generate-quiz', upload.single('pastPaper'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const { uploaderName, classroomId } = req.body;
        
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
        let prompt = `You are an expert tutor. Generate exactly 5 MCQs from this document. Return pure JSON array: {"question":"Q", "options":["A","B","C","D"], "correctAnswer":"A", "explanation":"Why"}`;
        
        let inputData = [];
        const fileName = req.file.originalname.toLowerCase();

        // Detect if the file is a PDF or a Word Document
        if (fileName.endsWith('.pdf')) {
            const pdfPart = { inlineData: { data: req.file.buffer.toString("base64"), mimeType: "application/pdf" } };
            inputData = [prompt, pdfPart];
        } else if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
            // Use mammoth to extract the raw text from the Word document
            const result = await mammoth.extractRawText({ buffer: req.file.buffer });
            prompt += `\n\nHere is the text extracted from the document:\n${result.value}`;
            inputData = [prompt];
        } else {
            return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF or .docx file.' });
        }

        const result = await model.generateContent(inputData);
        const quizData = JSON.parse(result.response.text());
        
        await supabase.from('quizzes').insert([{ uploader_name: uploaderName, quiz_data: quizData, classroom_id: classroomId }]);
        res.json({ success: true, quiz: quizData });
    } catch (error) { 
        console.error("AI Error:", error);
        res.status(500).json({ error: 'AI Error' }); 
    }
});

app.post('/api/tutor', async (req, res) => {
    const { question, wrongAnswer, correctAnswer } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `You are an encouraging, expert AI tutor helping a student. 
        The student just answered a multiple-choice question incorrectly.
        Question: "${question}"
        The student guessed: "${wrongAnswer}"
        The correct answer is actually: "${correctAnswer}"
        In 2 to 3 short, easy-to-understand sentences, explain exactly WHY their guess was incorrect, and explain why the correct answer makes sense. Be highly conversational, supportive, and address them directly.`;

        const result = await model.generateContent(prompt);
        res.json({ success: true, explanation: result.response.text() });
    } catch (error) { res.status(500).json({ error: 'Tutor AI failed' }); }
});

app.get('/api/quizzes', async (req, res) => {
    const { classId } = req.query;
    try {
        let query = supabase.from('quizzes').select('*').order('created_at', { ascending: false });
        if (classId && classId !== 'all') query = query.eq('classroom_id', classId);
        
        const { data, error } = await query;
        if (error) throw error; res.json({ success: true, quizzes: data });
    } catch (e) { res.status(500).json({ error: 'Failed fetch' }); }
});

// --- 3. CONTEXTUAL NOTES ---
app.get('/api/notes', async (req, res) => {
    const { classId } = req.query;
    try {
        let query = supabase.from('notes').select('*').order('created_at', { ascending: false });
        if (classId && classId !== 'all') query = query.eq('classroom_id', classId);

        const { data, error } = await query;
        if (error) throw error; res.json({ success: true, notes: data });
    } catch (e) { res.status(500).json({ error: 'Failed fetch' }); }
});

app.post('/api/notes', upload.single('noteFile'), async (req, res) => {
    const { topic, content, userId, authorName, classroomId } = req.body;
    try {
        const { data: user } = await supabase.from('users').select('role').eq('id', userId).single();
        if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Unauthorized' });

        let fileUrl = null;
        let fileName = null;

        if (req.file) {
            fileName = `${Date.now()}-${req.file.originalname.replace(/\s+/g, '_')}`; 
            const { error: uploadError } = await supabase.storage.from('notes_files').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
            if (uploadError) throw uploadError;
            const { data: urlData } = supabase.storage.from('notes_files').getPublicUrl(fileName);
            fileUrl = urlData.publicUrl;
        }

        const { error: insertError } = await supabase.from('notes').insert([{ topic, content, author_name: authorName, classroom_id: classroomId, file_url: fileUrl, file_name: fileName }]);
        if (insertError) throw insertError;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Failed post' }); }
});

// --- 4. CONTEXTUAL LEADERBOARD ---
app.get('/api/leaderboard', async (req, res) => {
    const { classId } = req.query;
    try {
        if (classId && classId !== 'all') {
            const { data: enrollments } = await supabase.from('enrollments').select('student_id').eq('classroom_id', classId);
            const studentIds = enrollments.map(e => e.student_id);
            if (studentIds.length === 0) return res.json({ success: true, leaderboard: [] });
            
            const { data } = await supabase.from('users').select('id, display_name, total_xp').in('id', studentIds).order('total_xp', { ascending: false }).limit(10);
            res.json({ success: true, leaderboard: data });
        } else {
            const { data } = await supabase.from('users').select('id, display_name, total_xp').order('total_xp', { ascending: false }).limit(10);
            res.json({ success: true, leaderboard: data });
        }
    } catch (e) { res.status(500).json({ error: 'Failed fetch' }); }
});

app.post('/api/update-xp', async (req, res) => {
    const { userId, xpToAdd } = req.body;
    try {
        const { data: user } = await supabase.from('users').select('total_xp').eq('id', userId).single();
        const newTotalXp = (user.total_xp || 0) + xpToAdd;
        const { data: updatedUser } = await supabase.from('users').update({ total_xp: newTotalXp }).eq('id', userId).select('id, display_name, total_xp, role').single();
        res.json({ success: true, user: updatedUser });
    } catch (e) { res.status(500).json({ error: 'Failed update' }); }
});

// --- 5. ADMIN & CLASSROOMS ---
app.post('/api/admin/delete-quiz', async (req, res) => {
    const { quizId, userId } = req.body;
    try {
        const { data: user } = await supabase.from('users').select('role').eq('id', userId).single();
        if (user && user.role === 'teacher') { await supabase.from('quizzes').delete().eq('id', quizId); res.json({ success: true }); } 
        else { res.status(403).json({ error: 'Unauthorized' }); }
    } catch (e) { res.status(500).json({ error: 'Failed delete' }); }
});

app.post('/api/classrooms/create', async (req, res) => {
    const { name, teacherId } = req.body;
    try {
        const { data: user } = await supabase.from('users').select('role').eq('id', teacherId).single();
        if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Unauthorized' });
        const joinCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const { data } = await supabase.from('classrooms').insert([{ name, teacher_id: teacherId, join_code: joinCode }]).select().single();
        res.json({ success: true, classroom: data });
    } catch (e) { res.status(500).json({ error: 'Failed create' }); }
});

app.post('/api/classrooms/join', async (req, res) => {
    const { studentId, joinCode } = req.body;
    try {
        const { data: classroom, error: findError } = await supabase.from('classrooms').select('id, name').eq('join_code', joinCode).single();
        if (findError || !classroom) return res.status(404).json({ error: 'Invalid code.' });
        const { error: enrollError } = await supabase.from('enrollments').insert([{ student_id: studentId, classroom_id: classroom.id }]);
        if (enrollError) { if (enrollError.code === '23505') return res.status(400).json({ error: 'Already joined.' }); throw enrollError; }
        res.json({ success: true, classroomName: classroom.name });
    } catch (e) { res.status(500).json({ error: 'Failed join' }); }
});

app.get('/api/classrooms/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const { data: user } = await supabase.from('users').select('role').eq('id', userId).single();
        let classes = [];
        if (user.role === 'teacher') {
            const { data } = await supabase.from('classrooms').select('*').eq('teacher_id', userId);
            classes = data || [];
        } else {
            const { data } = await supabase.from('enrollments').select('classrooms(id, name, join_code)').eq('student_id', userId);
            classes = (data || []).map(entry => entry.classrooms);
        }
        res.json({ success: true, classrooms: classes });
    } catch (e) { res.status(500).json({ error: 'Failed fetch' }); }
});

app.listen(3000, () => {
    console.log('\n=======================================');
    console.log('✅ Server running on http://localhost:3000');
    console.log('=======================================\n');
});