// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const { validate: isUuid } = require('uuid');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const openpgp = require('openpgp');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Подключение к Redis для публикации и подписки
const redisPub = createClient({ url: 'redis://127.0.0.1:6379' });
const redisSub = createClient({ url: 'redis://127.0.0.1:6379' });

(async () => {
  try {
    await redisPub.connect();
    console.log('Подключение к Redis-pub успешно');
  } catch (err) {
    console.error('Ошибка подключения Redis-pub:', err.message);
    process.exit(1);
  }
  try {
    await redisSub.connect();
    console.log('Подключение к Redis-sub успешно');
  } catch (err) {
    console.error('Ошибка подключения Redis-sub:', err.message);
    process.exit(1);
  }
})();

// Ограничение API-запросов
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use('/messages', apiLimiter);

const formatTime = () => new Date().toISOString();

// Функция проверки PGP-ключа
const isValidPGPKey = async (key) => {
  try {
    await openpgp.readKey({ armoredKey: key });
    return true;
  } catch (err) {
    console.error('Ошибка при проверке PGP-ключа:', err.message);
    return false;
  }
};

// Обработка WebSocket-соединения
wss.on('connection', (ws) => {
  console.log(`Новое соединение с клиентом: [${formatTime()}]`);
  ws.on('message', async (data) => {
    try {
      const parsedData = JSON.parse(data.toString());
      const { clientId, publicKey, type, encryptedMessage } = parsedData;

      if (!clientId || !isUuid(clientId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Некорректный clientId' }));
        return;
      }

      if (type === 'key_exchange') {
        if (!await isValidPGPKey(publicKey)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Недействительный PGP publicKey' }));
          return;
        }
        ws.clientId = clientId;
        ws.publicKey = publicKey;
        // Рассылаем публичный ключ всем другим клиентам
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'key_exchange', clientId, publicKey }));
          }
        });
        // Отправляем текущему клиенту ключи других клиентов (если они есть)
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN && client.publicKey) {
            ws.send(JSON.stringify({ type: 'key_exchange', clientId: client.clientId, publicKey: client.publicKey }));
          }
        });
        ws.send(JSON.stringify({ type: 'info', message: 'Ключ успешно отправлен' }));
      } else if (type === 'message') {
        const timestamp = formatTime();
        const messageData = JSON.stringify({ clientId, encryptedMessage, timestamp });
        // Сохраняем сообщение в Redis и публикуем его в канал
        await redisPub.rPush('chat:messages', messageData);
        redisPub.publish('chat', messageData);
      }
      // Дополнительно можно добавить обработку сигналов для видеозвонков (например, video_signal)
    } catch (err) {
      console.error('Ошибка обработки сообщения:', err.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Ошибка обработки сообщения' }));
    }
  });

  ws.on('close', () => {
    console.log(`Клиент ${ws.clientId} отключился`);
  });

  ws.on('error', (err) => {
    console.error(`Ошибка WebSocket у клиента (${ws.clientId}):`, err.message);
  });
});

// Подписка на Redis-канал и пересылка сообщений всем подключенным клиентам
redisSub.subscribe('chat', (message) => {
  const parsedMessage = JSON.parse(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'message',
        clientId: parsedMessage.clientId,
        encryptedMessage: parsedMessage.encryptedMessage,
        timestamp: parsedMessage.timestamp,
      }));
    }
  });
});

// REST API для получения истории сообщений
app.get('/messages', async (req, res) => {
  try {
    const messages = await redisPub.lRange('chat:messages', 0, 99);
    res.status(200).json(messages.map(JSON.parse));
  } catch (err) {
    console.error('Ошибка получения сообщений:', err);
    res.status(500).send('Не удалось получить сообщения');
  }
});

// Запуск HTTP-сервера
server.listen(8080, () => console.log('Сервер работает на http://localhost:8080'));
