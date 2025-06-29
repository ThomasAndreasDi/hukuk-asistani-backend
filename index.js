const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MemoryVectorStore } = require("langchain/vectorstores/memory");
const { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");
const admin = require('firebase-admin');
require('dotenv/config');

const app = express();
app.use(express.json());
app.use(cors());

// --- Firebase Kurulumu ---
try {
    const serviceAccount = require('./serviceAccountKey.json'); 
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    console.error("Firebase hizmet hesabı anahtarı bulunamadı veya hatalı.");
}
const db = admin.firestore();
// -------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("Hata: GEMINI_API_KEY ortam değişkeni bulunamadı.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// DÜZENLEME: Model adı, en stabil sürüm olan "gemini-1.5-flash" olarak değiştirildi.
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 
const embeddings = new GoogleGenerativeAIEmbeddings({ apiKey: GEMINI_API_KEY });

let vectorStore;

async function initializeVectorStore() {
    try {
        const allDocs = [];
        const files = fs.readdirSync('./');
        const pdfFiles = files.filter(file => path.extname(file).toLowerCase() === '.pdf');

        if (pdfFiles.length === 0) {
            console.warn("Uyarı: Projede işlenecek PDF dosyası bulunamadı.");
            return;
        }
        console.log(`İşlenecek PDF dosyaları: ${pdfFiles.join(', ')}`);

        for (const pdfFile of pdfFiles) {
            console.log(`İşleniyor: ${pdfFile}...`);
            const pdfPath = `./${pdfFile}`;
            const dataBuffer = fs.readFileSync(pdfPath);
            const pdfData = await pdf(dataBuffer);
            
            const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1500, chunkOverlap: 200 });
            const docs = await splitter.createDocuments([pdfData.text]);
            allDocs.push(...docs);
        }
        
        console.log("Vektör veritabanı tüm belgelerle oluşturuluyor...");
        vectorStore = await MemoryVectorStore.fromDocuments(allDocs, embeddings);
        console.log("Vektör veritabanı başarıyla oluşturuldu ve hazır.");

    } catch (error) {
        console.error("Vektör veritabanı oluşturulurken hata oluştu:", error);
    }
}

app.post('/api/chat', async (req, res) => {
    if (!vectorStore) {
        return res.status(503).json({ error: "Sunucu henüz hazır değil, PDF işleniyor. Lütfen birkaç dakika sonra tekrar deneyin." });
    }

    try {
        const { conversationHistory } = req.body;
        const userQuery = conversationHistory[conversationHistory.length - 1].parts[0].text;

        const relevantDocs = await vectorStore.similaritySearch(userQuery, 5);
        const context = relevantDocs.map(doc => doc.pageContent).join("\n\n---\n\n");

        const promptWithContext = `
            Sen, Türkiye Cumhuriyeti kanunları üzerine uzmanlaşmış bir yapay zeka hukuk asistanısın.
            Görevin, sana verilen PDF belgesindeki bilgilere dayanarak cevap vermektir.
            
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
        
        if (responseText && db) {
            try {
                const userPrompt = conversationHistory.slice(-1)[0].parts[0].text;
                await db.collection('conversations').add({
                    user_prompt: userPrompt,
                    model_response: responseText,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log("Konuşma başarıyla veritabanına kaydedildi.");
            } catch (dbError) {
                console.error("Veritabanı Kayıt Hatası:", dbError);
            }
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
