// Импорт необходимых модулей
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("redis");
const { v4: uuidv4 } = require("uuid");
const { validate: isUuid } = require("uuid");
require("dotenv").config();
const rateLimit = require("express-rate-limit");
const openpgp = require("openpgp");

// Инициализация Express и HTTP-сервера
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
// ================================
// Redis: подключение и конфигурация
// ================================
console.log("Подключаемся к Redis по адресу:", process.env.REDIS_URL);
const redisPub = createClient({ url: process.env.REDIS_URL });
const redisSub = createClient({ url: process.env.REDIS_URL });

const connectRedis = async () => {
  try {
    await redisPub.connect();
    console.log("Подключение к Redis-pub успешно");
  } catch (err) {
    console.error("Ошибка подключения Redis-pub:", err.message);
    process.exit(1);
  }
  try {
    await redisSub.connect();
    console.log("Подключение к Redis-sub успешно");
  } catch (err) {
    console.error("Ошибка подключения Redis-sub:", err.message);
    process.exit(1);
  }
};
connectRedis();
// ================================
// Ограничение запросов для REST API
// ================================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // максимум 100 запросов за 15 минут
});
app.use("/messages", apiLimiter);
// ================================
// Вспомогательные функции
// ================================
// Функция для форматирования текущего времени в ISO-формате
const formatTime = () => new Date().toISOString();
// Функция проверки валидности PGP-ключа
const isValidPGPKey = async (armoredKey) => {
  try {
    await openpgp.readKey({ armoredKey });
    return true;
  } catch (err) {
    console.error("Ошибка при проверке PGP-ключа:", err.message);
    return false;
  }
};
// Функция для широковещательной рассылки сообщений всем подключённым клиентам
const broadcastMessage = (messageObj) => {
  const messageStr = JSON.stringify(messageObj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
};
// ================================
// WebSocket-обработка
// ================================
wss.on("connection", (ws) => {
  console.log(`Новое соединение с клиентом: [${formatTime()}]`);
  ws.on("message", async (data) => {
    try {
      const parsedData = JSON.parse(data.toString());
      const { clientId, publicKey, type, encryptedMessage } = parsedData;
      // Проверка clientId на наличие и корректность UUID
      if (!clientId || !isUuid(clientId)) {
        ws.send(
          JSON.stringify({ type: "error", message: "Некорректный clientId" })
        );
        return;
      }
      // Обработка обмена ключами
      if (type === "key_exchange") {
        // Проверяем валидность полученного PGP-ключа
        const validKey = await isValidPGPKey(publicKey);
        if (!validKey) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Недействительный PGP publicKey",
            })
          );
          return;
        }
        // Сохраняем clientId и publicKey в объекте соединения
        ws.clientId = clientId;
        ws.publicKey = publicKey;
        // Рассылаем данный ключ всем другим клиентам
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({ type: "key_exchange", clientId, publicKey })
            );
          }
        });
        // Отправляем текущему клиенту ключи других клиентов (если они уже есть)
        wss.clients.forEach((client) => {
          if (
            client !== ws &&
            client.readyState === WebSocket.OPEN &&
            client.publicKey
          ) {
            ws.send(
              JSON.stringify({
                type: "key_exchange",
                clientId: client.clientId,
                publicKey: client.publicKey,
              })
            );
          }
        });
        // Информируем клиента о том, что обмен ключами прошёл успешно
        ws.send(
          JSON.stringify({ type: "info", message: "Ключ успешно отправлен" })
        );
      }
      // Обработка текстовых сообщений
      else if (type === "message") {
        const timestamp = formatTime();
        const messageData = JSON.stringify({
          clientId,
          encryptedMessage,
          timestamp,
        });
       // Сохраняем сообщение в Redis (список сообщений) и публикуем в канал "chat"
       await redisPub.rPush("chat:messages", messageData);
       redisPub.publish("chat", messageData);
     }
     // Добавить обработку других типов сообщений, например, video_signal для видеозвонков
    } catch (err) {
      console.error("Ошибка обработки сообщения:", err.message);
      ws.send(JSON.stringify({ type: "error", message: "Ошибка обработки сообщения" }));
    }
  });
  ws.on("close", () => {
    console.log(`Клиент ${ws.clientId} отключился`);
  });
  ws.on("error", (err) => {
    console.error(`Ошибка WebSocket у клиента (${ws.clientId}):`, err.message);
  });
});

// Подписка на Redis-канал "chat" для пересылки сообщений
redisSub.subscribe("chat", (message) => {
  try {
    const parsedMessage = JSON.parse(message);
    broadcastMessage({
      type: "message",
      clientId: parsedMessage.clientId,
      encryptedMessage: parsedMessage.encryptedMessage,
      timestamp: parsedMessage.timestamp,
    });
  } catch (err) {
    console.error("Ошибка парсинга сообщения из Redis:", err.message);
  }
});
// ================================
// REST API: Получение истории сообщений
// ================================
app.get("/messages", async (req, res) => {
  try {
    const messages = await redisPub.lRange("chat:messages", 0, 99);
    res.status(200).json(messages.map(JSON.parse));
  } catch (err) {
    console.error("Ошибка получения сообщений:", err);
    res.status(500).send("Не удалось получить сообщения");
  }
});
// ================================
// Запуск HTTP-сервера
// ================================
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "http://localhost";
server.listen(PORT, () => {
  console.log(`Сервер работает на ${HOST}:${PORT}`);
});
