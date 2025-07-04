const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MemoryVectorStore } = require("langchain/vectorstores/memory");
const { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const fs = require("fs");
const path = require("path");
const admin = require('firebase-admin');
const crypto = require('crypto');
require('dotenv/config');

const app = express();
app.use(express.json());
app.use(cors());

// --- Firebase Kurulumu ---
try {
    // Use environment variables for Firebase configuration instead of exposed JSON file
    const serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
        universe_domain: "googleapis.com"
    };

    // Validate that all required Firebase environment variables are present
    const requiredEnvVars = [
        'FIREBASE_PROJECT_ID',
        'FIREBASE_PRIVATE_KEY_ID', 
        'FIREBASE_PRIVATE_KEY',
        'FIREBASE_CLIENT_EMAIL',
        'FIREBASE_CLIENT_ID',
        'FIREBASE_CLIENT_X509_CERT_URL'
    ];

    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
        throw new Error(`Missing required Firebase environment variables: ${missingVars.join(', ')}`);
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || "https://thomasandreas-ai.firebaseio.com"
    });
    console.log("Firebase başarıyla başlatıldı.");
} catch (e) {
    console.error("Firebase başlatma hatası:", e.message);
    console.error("Lütfen Firebase environment variables'larının doğru ayarlandığından emin olun.");
    // Don't exit the process, but log that Firebase is not available
    console.warn("Firebase olmadan devam ediliyor. Veritabanı işlevleri kullanılamayacak.");
}

const db = admin.firestore();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("Hata: GEMINI_API_KEY ortam değişkeni bulunamadı.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const embeddings = new GoogleGenerativeAIEmbeddings({ apiKey: GEMINI_API_KEY });

let vectorStore;

async function initializeVectorStore() {
    try {
        const allDocs = [];
        const txtFiles = fs.readdirSync('./txt').filter(file => file.endsWith('.txt'));

        if (txtFiles.length === 0) {
            console.warn("Uyarı: TXT dosya dizininde işlenecek dosya bulunamadı.");
            return;
        }
        console.log(`İşlenecek TXT dosyaları: ${txtFiles.join(', ')}`);

        for (const txtFile of txtFiles) {
            console.log(`İşleniyor: ${txtFile}...`);
            const txtPath = `./txt/${txtFile}`;
            const text = fs.readFileSync(txtPath, 'utf8');
            
            const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1500, chunkOverlap: 200 });
            const docs = await splitter.createDocuments([text]);
            allDocs.push(...docs);
        }
        
        console.log("Vektör veritabanı tüm belgelerle oluşturuluyor...");
        vectorStore = await MemoryVectorStore.fromDocuments(allDocs, embeddings);
        console.log("Vektör veritabanı başarıyla oluşturuldu ve hazır.");

    } catch (error) {
        console.error("Vektör veritabanı oluşturulurken hata oluştu:", error);
    }
}

app.get('/api/chat', (req, res) => {
    res.status(200).json({ 
        status: 'active',
        message: 'Backend çalışıyor. POST istekleri bekleniyor.',
        timestamp: new Date().toISOString()
    });
});

app.post('/api/chat', async (req, res) => {
    if (!vectorStore) {
        return res.status(503).json({ error: "Sunucu henüz hazır değil, TXT dosyaları işleniyor. Lütfen birkaç dakika sonra tekrar deneyin." });
    }

    try {
        const { conversationHistory } = req.body;
        const userQuery = conversationHistory[conversationHistory.length - 1].parts[0].text;

        const relevantDocs = await vectorStore.similaritySearch(userQuery, 5);
        const context = relevantDocs.map(doc => doc.pageContent).join("\n\n---\n\n");

        const promptWithContext = `
            Sen, Türkiye Cumhuriyeti kanunları üzerine uzmanlaşmış bir yapay zeka hukuk asistanısın.
            Görevin, sana verilen TXT belgesindeki bilgilere dayanarak cevap vermektir.
            
            **KESİN KURALLAR:**
            1.  Kullanıcının sorusuna cevap vermek için **SADECE ve SADECE** sana aşağıda verilen 'BAĞLAM' metnini kullan. Kendi genel bilgini veya hafızandaki bilgileri **KESİNLİKLE KULLANMA**.
            2.  Eğer kullanıcının sorusunun cevabı 'BAĞLAM' metninde açıkça bulunuyorsa, o bilgiyi olduğu gibi aktar.
            3.  Eğer kullanıcının sorusunun cevabı 'BAĞLAM' metninde yoksa veya emin değilsen, **KESİNLİKLE TAHMİN YÜRÜTME**. Bunun yerine, SADECE şu cevabı ver: "Aradığınız konu, sağladığınız belgelerde bulunamadı. Kanun maddelerinin en güncel ve doğru metni için lütfen resmi kaynakları kontrol ediniz: https://www.mevzuat.gov.tr/"
            4.  Her cevabın sonuna standart yasal uyarıyı ekle: 'Bu bilgiler genel bilgi amaçlı olup, hukuki mütalaa niteliği taşımaz. Resmi danışmanlık için Av. Thomas Andreas Di Constantinople ile (Telegram: @thomas_andreas_di veya WhatsApp: +905325225530) iletişime geçmeniz önemle tavsiye edilir.'

            BAĞLAM:
            ---
            ${context}
            ---

            KULLANICI SORUSU: ${userQuery}
        `;

        const result = await model.generateContent(promptWithContext);
        const response = await result.response;
        const responseText = response.text();
        
        // Firestore'a kaydetme işlemi
        try {
            await db.collection('conversations').add({
                user_prompt: userQuery,
                model_response: responseText,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                session_id: crypto.randomUUID() // Secure UUID generation
            });
            console.log("Konuşma Firestore'a kaydedildi.");
        } catch (dbError) {
            console.error("Firestore kayıt hatası:", dbError);
        }
        
        res.json({ candidates: [{ content: { parts: [{ text: responseText }] } }] });

    } catch (error) {
        console.error('Sunucu Hatası:', error);
        res.status(500).json({ error: "İstek işlenirken bir sunucu hatası oluştu." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor...`);
    initializeVectorStore();
});
