const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const app = express();
    const allowedOrigins = [
      'http://localhost:5173',                  // للتطوير المحلي
      'https://bar4amlg.github.io',            // موقعك المنشور
    ];

    app.use(cors({
      origin: function (origin, callback) {
        // السماح للطلبات التي لا تحوي origin (مثل Postman) أو الموجود ضمن القائمة
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true
    }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- إعداد قاعدة البيانات SQLite ---
const db = new Database('cv_data.db'); // سينشئ ملف cv_data.db في مجلد المشروع
db.pragma('journal_mode = WAL'); // لتحسين الأداء
db.exec(`
  CREATE TABLE IF NOT EXISTS portfolios (
    id TEXT PRIMARY KEY,
    user_name TEXT NOT NULL,
    skills TEXT,       -- سنخزن المهارات كمصفوفة JSON نصية
    bio TEXT,
    projects TEXT,     -- سنخزن المشاريع كمصفوفة JSON نصية
    template_id TEXT,
    photo_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// تجهيز استعلامات مُعدة مسبقاً لتسريع الأداء
const insertStmt = db.prepare(`
  INSERT INTO portfolios (id, user_name, skills, bio, projects, template_id, photo_url)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getByIdStmt = db.prepare('SELECT * FROM portfolios WHERE id = ?');

// --- إعداد Multer للتخزين المحلي الدائم للصور ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// --- Gemini ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

app.get('/', (req, res) => res.json({ message: 'API محلية مع SQLite + Gemini' }));

app.post('/api/generate-cv', upload.single('photo'), async (req, res) => {
  try {
    console.log('🟢 استقبال طلب...');
    const { name, skills, bio, projects, templateId } = req.body;

    let parsedProjects;
    try {
      parsedProjects = projects ? JSON.parse(projects) : [];
    } catch (e) {
      return res.status(400).json({ success: false, message: 'صيغة المشاريع غير صحيحة' });
    }
    const skillsArray = skills ? skills.split(',').map(s => s.trim()).filter(s => s) : [];

    // --- تحسين المحتوى ---
    const prompt = `أنت مساعد محترف لكتابة السير الذاتية. أعد صياغة المعلومات التالية لجعلها أكثر احترافية وجاذبية ومتوافقة مع أنظمة ATS. ركز على الإنجازات والأثر.
المعلومات الأصلية:
- المهارات: ${JSON.stringify(skillsArray)}
- النبذة الشخصية: "${bio}"
- المشاريع: ${JSON.stringify(parsedProjects)}
أعد النتيجة ككائن JSON فقط بالهيكل التالي:
{ "enhancedSkills": [...], "enhancedBio": "...", "enhancedProjects": [{"name":"...", "description":"..."}] }`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const enhancedData = JSON.parse(text);

    // --- الصورة (محلية) ---
    let photoUrl = null;
    if (req.file) {
      photoUrl = `/uploads/${req.file.filename}`; // المسار النسبي
    }

    // --- حفظ في SQLite ---
    const id = uuidv4(); // توليد معرف فريد
    insertStmt.run(
      id,
      name,
      JSON.stringify(enhancedData.enhancedSkills),
      enhancedData.enhancedBio,
      JSON.stringify(enhancedData.enhancedProjects),
      templateId,
      photoUrl
    );
    console.log('✅ تم الحفظ محلياً، ID:', id);

    const finalData = {
      id,
      name,
      photo: photoUrl,
      skills: enhancedData.enhancedSkills,
      bio: enhancedData.enhancedBio,
      projects: enhancedData.enhancedProjects,
      templateId,
    };

    res.status(200).json({ success: true, data: finalData });
  } catch (error) {
    console.error('❌ خطأ:', error);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
});

// جلب سيرة محفوظة
app.get('/api/portfolio/:id', (req, res) => {
  const row = getByIdStmt.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'غير موجود' });
  
  res.json({
    success: true,
    data: {
      name: row.user_name,
      photo: row.photo_url,
      skills: JSON.parse(row.skills),
      bio: row.bio,
      projects: JSON.parse(row.projects),
      templateId: row.template_id,
    }
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 الخادم المحلي على ${PORT} مع SQLite`));