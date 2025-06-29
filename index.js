const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 10000;

// CORS ayarları (güncellendi)
const corsOptions = {
  origin: [
    'https://www.thomasandreasdiconstantinople.av.tr',
    'https://thomasandreasdiconstantinople.av.tr'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
};

app.use(cors(corsOptions));
app.use(express.json());

// Google Gemini API anahtarı
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// GET endpoint'i eklendi
app.get('/api/chat', (req, res) => {
  res.status(200).json({ 
    status: 'active',
    message: 'Backend çalışıyor. POST istekleri bekleniyor.',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    console.log("Gelen istek:", req.body);
    
    // Model adı düzeltildi! (gemini-1.5-flash kullanılıyor)
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const conversation = req.body.conversationHistory;
    
    // Son kullanıcı mesajını bul
    const lastUserMessage = conversation
      .filter(msg => msg.role === "user")
      .pop()?.parts[0]?.text || "";
    
    const chat = model.startChat({
      history: conversation,
      generationConfig: { maxOutputTokens: 1000 }
    });

    const result = await chat.sendMessage(lastUserMessage);
    const response = await result.response;
    const text = response.text();

    console.log("Oluşturulan yanıt:", text);
    
    res.json({
      candidates: [{
        content: {
          parts: [{ text }]
        }
      }]
    });
    
  } catch (error) {
    console.error("Backend hatası:", error);
    res.status(500).json({ 
      error: "İstek işlenirken bir sunucu hatası oluştu",
      details: error.message
    });
  }
});

// Sunucuyu başlat
app.listen(port, () => {
  console.log(`Sunucu ${port} portunda çalışıyor...`);
});
