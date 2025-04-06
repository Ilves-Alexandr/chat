import React, { useEffect, useState, useRef, useCallback } from "react";
import * as openpgp from "openpgp";
import { v4 as uuidv4 } from "uuid";
import {
  generateKeys,
  encryptMessage,
  decryptMessage,
  storePrivateKey,
  retrievePrivateKey,
  initializeDB,
} from "../utils/crypto";
import {
  encryptPrivateKey,
  decryptPrivateKey,
} from "../utils/cryptoProtection";
// import { sha256 } from "js-sha256"; // Пока не используется
import VideoChat from "./VideoChat";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./Chat.css";

const Chat = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [file, setFile] = useState(null);
  const [chatType, setChatType] = useState("group"); // 'group' или 'private'
  const [recipientId, setRecipientId] = useState(""); // ID собеседника для приватного чата
  const [confirmedRecipientId, setConfirmedRecipientId] = useState("");
  const [showRecipientInput, setShowRecipientInput] = useState(false);
  const [keys, setKeys] = useState({
    publicKey: null,
    recipientPublicKey: null,
  });

  // useRef для хранения приватного ключа и WebSocket‑соединения без перерендеринга
  const privateKeyRef = useRef(null);
  const wsRef = useRef(null);
  const passphrase = "testpass";

  // Функция восстановления (очистки) аккаунта
  const clearUserData = async () => {
    localStorage.removeItem("clientId");
    toast.info("ClientId удалён из LocalStorage");
    try {
      const db = await initializeDB();
      const transaction = db.transaction("keys", "readwrite");
      const store = transaction.objectStore("keys");
      const request = store.delete("privateKey");
      request.onsuccess = () => {
        console.log("Приватный ключ удалён из IndexedDB");
        toast.info("Приватный ключ удалён из IndexedDB");
      };
      request.onerror = (e) => {
        console.error(
          "Ошибка удаления приватного ключа из IndexedDB:",
          e.target.error
        );
        toast.error("Ошибка удаления приватного ключа из IndexedDB");
      };
    } catch (error) {
      console.error("Ошибка при открытии IndexedDB:", error);
      toast.error("Ошибка при доступе к IndexedDB");
    }
    try {
      const clientId = localStorage.getItem("clientId") || "текущий clientId";
      const response = await fetch(`/api/clearUserData?clientId=${clientId}`, {
        method: "DELETE",
      });
      if (response.ok) {
        console.log("Данные пользователя удалены на сервере");
        toast.success("Данные пользователя удалены на сервере");
      } else {
        console.error("Ошибка удаления данных на сервере");
        toast.error("Ошибка удаления данных на сервере");
      }
    } catch (err) {
      console.error("Ошибка вызова API для очистки данных:", err);
      toast.error("Ошибка очистки данных на сервере");
    }

    // 4. Сброс локальных состояний
    setMessages([]);
    setKeys({ publicKey: null, recipientPublicKey: null });
    setInput("");
    setFile(null);
    setRecipientId("");
    setConfirmedRecipientId("");

    // 5. Сообщаем пользователю о необходимости перезагрузить страницу
    toast.info(
      "Данные пользователя очищены. Перезагрузите страницу для повторной генерации ключей."
    );
  };

  // Функция для восстановления доступа к аккаунту (очистка ключей и clientId)
  const recoverAccount = async () => {
    try {
      const storedKey = await retrievePrivateKey(passphrase);
      if (!storedKey) {
        toast.error("Приватный ключ не найден.");
        return;
      }
      const decryptedKey = await decryptPrivateKey(storedKey, passphrase);
      privateKeyRef.current = decryptedKey;
      const extractedKey = await openpgp.readKey({ armoredKey: decryptedKey });
      const publicKey = extractedKey.toPublic().armor();
      setKeys((prev) => ({ ...prev, publicKey }));
      toast.success("Аккаунт успешно восстановлен.");
    } catch (err) {
      console.error("Ошибка восстановления аккаунта:", err);
      toast.error("Ошибка восстановления аккаунта");
    }
  };
  // Функция для подтверждения введённого идентификатора собеседника
  const confirmRecipient = () => {
    if (!recipientId.trim()) {
      toast.error("Введите корректный идентификатор собеседника");
      return;
    }
    setConfirmedRecipientId(recipientId.trim());
    toast.success(`Получатель подтверждён: ${recipientId.trim()}`);
  };
  // Расширенная версия функции decryptMessage с проверкой формата
  const safeDecryptMessage = async (encryptedMessage, privateKey, passphrase) => {
    // Если сообщение не похоже на PGP зашифрованное (не начинается с PGP заголовка), выбрасываем ошибку
    if (
      typeof encryptedMessage !== "string" ||
      !encryptedMessage.startsWith("-----BEGIN PGP MESSAGE-----")
    ) {
      throw new Error("Полученное сообщение не является корректным PGP-сообщением");
    }
    // Вызываем оригинальную функцию decryptMessage
    return await decryptMessage(encryptedMessage, privateKey, passphrase);
  };
  
  useEffect(() => {
    const initChat = async () => {
      try {
        // 1. Генерация или получение уникального clientId (храним в localStorage)
        let clientId = localStorage.getItem("clientId");
        if (!clientId) {
          clientId = uuidv4();
          localStorage.setItem("clientId", clientId);
          console.log("Создан новый clientId:", clientId);
          toast.info(`Создан новый clientId: ${clientId}`);
        } else {
          console.log("Используется существующий clientId:", clientId);
          toast.info(`Используется существующий clientId: ${clientId}`);
        }

        // 2. Загрузка приватного ключа из IndexedDB или генерация новых ключей
        let privateKey;
        let publicKey;
        // Запрашиваем секретную фразу у пользователя
        console.log("Используемый passphrase:", passphrase);
        try {
          privateKey = await retrievePrivateKey(passphrase);
          console.log("Приватный ключ успешно восстановлен:", privateKey);
        } catch (error) {
          console.error(
            "Приватный ключ не найден или ошибка дешифровки:",
            error
          );
          toast.error(
            "Приватный ключ не найден. Будут сгенерированы новые ключи."
          );
          const generatedKeys = await generateKeys(passphrase);
          privateKey = generatedKeys.privateKey;
          publicKey = generatedKeys.publicKey;
          const protectedKey = await encryptPrivateKey(privateKey, passphrase);
          console.log(`protectedKey:: ${protectedKey}`);
          await storePrivateKey(protectedKey);
          console.log("Ключи сгенерированы и сохранены");
          toast.success("Ключи сгенерированы и сохранены");
          // if (!privateKey) {
          //   // Если ключ не найден – генерируем новую пару ключей
          //   const generatedKeys = await generateKeys(passphrase);
          //   privateKey = generatedKeys.privateKey;
          //   publicKey = generatedKeys.publicKey;
          //   // Шифруем приватный ключ перед сохранением
          //   const protectedKey = await encryptPrivateKey(
          //     privateKey,
          //     passphrase
          //   );
          //   console.log(`protectedKey:: ${protectedKey}`);

          //   await storePrivateKey(protectedKey);
          //   console.log("Ключи сгенерированы и сохранены");
          //   toast.success("Ключи сгенерированы и сохранены");
          // } else {
          //   // Если ключ найден, проверяем его формат:
          //   // если строка содержит разделитель ":", считаем, что ключ зашифрован,
          //   // иначе – не защищён (в целях совместимости)
          //   if (privateKey.includes(":")) {
          //     const protectedKey = privateKey;
          //     const parts = protectedKey.split(":");
          //     console.log("Protected key parts:", parts);
          //     if (parts.length !== 3) {
          //       console.error(
          //         "Зашифрованный ключ должен содержать три части: соль, IV и зашифрованные данные"
          //       );
          //       toast.error("Неверный формат зашифрованного ключа");
          //       return;
          //     }
          //     try {
          //       privateKey = await decryptPrivateKey(protectedKey, passphrase);
          //       console.log(
          //         "Приватный ключ дешифрован из хранилища",
          //         privateKey
          //       );
          //     } catch (err) {
          //       console.error("Ошибка дешифровки приватного ключа:", err);
          //       toast.error("Ошибка дешифровки приватного ключа");
          //       return; // Прерываем инициализацию, если не удалось расшифровать
          //     }
          //   } else {
          //     console.log("Приватный ключ загружен из хранилища (без защиты)");
          //   }
          //   if (!publicKey) {
          //     const extractedKey = await openpgp.readKey({
          //       armoredKey: privateKey,
          //     });
          //     publicKey = extractedKey.toPublic().armor();
          //     console.log("Извлечённый публичный ключ:", publicKey);
          //     toast.success("Приватный ключ загружен из хранилища");
          //   }
          // }
          // Сохраняем приватный ключ в useRef и обновляем состояние с публичным ключом
          if (!publicKey) {
            const extractedKey = await openpgp.readKey({
              armoredKey: privateKey,
            });
            publicKey = extractedKey.toPublic().armor();
            console.log("Извлечённый публичный ключ:", publicKey);
            toast.success("Приватный ключ загружен из хранилища");
          }
          privateKeyRef.current = privateKey;
          setKeys((prevKeys) => ({ ...prevKeys, publicKey }));
        }
        if (!wsRef.current) {
          console.log("Инициализация WebSocket-соединения...");
          const wsUrl =
            window.location.protocol === "https:"
              ? process.env.REACT_APP_WEBSOCKET_URL
              : "ws://localhost:8080";
          console.log(`wsUrl::${wsUrl}`);
          wsRef.current = new WebSocket(wsUrl);
        }
        wsRef.current.onopen = () => {
          console.log("WebSocket подключен");
          if (clientId && publicKey) {
            // Отправляем серверу сообщение типа "key_exchange" с нашим публичным ключом и clientId
            wsRef.current.send(
              JSON.stringify({
                type: "key_exchange",
                publicKey,
                clientId,
              })
            );
            console.log("Публичный ключ и clientId отправлены на сервер");
          } else {
            console.error("Отсутствует clientId или publicKey");
          }
        };
        wsRef.current.onmessage = async (event) => {
          try {
            let data = event.data;
            // Если получено не строковое значение, преобразуем его в строку
            if (typeof data !== "string") {
              data = data.toString();
              console.warn(
                "Полученное сообщение не является строкой, преобразуем его к строке"
              );
            }
            data = JSON.parse(data);
            console.log("Получено сообщение от сервера:", data);
            // Если это обмен ключами – сохраняем публичный ключ собеседника
            if (data.type === "key_exchange" && data.publicKey) {
              try {
                setKeys((prevKeys) => ({
                  ...prevKeys,
                  recipientPublicKey: data.publicKey,
                }));
                console.log(
                  "Получен публичный ключ другого клиента:",
                  data.publicKey
                );
              } catch (err) {
                console.error("Ошибка обработки ключа:", err.message);
              }
            } else if (data.type === "message") {
              let text;
              try {
                // Если поле recipientId присутствует, это приватное сообщение
                if (data.recipientId) {
                  // Проверяем, что сообщение предназначено для текущего клиента
                  if (data.recipientId === clientId) {
                    text = await safeDecryptMessage(
                      data.encryptedMessage,
                      privateKeyRef.current,
                      passphrase
                    );
                  } else {
                    // Если сообщение не для вас — можно его проигнорировать или обработать по-другому
                    console.log(
                      "Приватное сообщение не для этого клиента, оно адресовано:",
                      data.recipientId
                    );
                    return;
                  }
                } else {
                  // Групповой чат: сообщение передаётся в открытом виде
                  text = data.encryptedMessage;
                }
                setMessages((prev) => [
                  ...prev,
                  { userId: data.clientId, text },
                ]);
              } catch (error) {
                console.error("Ошибка обработки сообщения", error);
                toast.error("Ошибка обработки сообщения");
              }
            } else if (data.type === "file") {
              // Обработка входящего зашифрованного файла
              let fileData;
              try {
                if (data.recipientId) {
                  // Проверяем, что сообщение предназначено для текущего клиента
                  if (data.recipientId === clientId) {
                    fileData = await safeDecryptMessage(
                      data.encryptedFile,
                      privateKeyRef.current,
                      passphrase
                    );
                    // Здесь можно создать Blob и отобразить ссылку для скачивания:
                    const blob = new Blob([new Uint8Array(fileData)], {
                      type: data.fileType,
                    });
                    const fileUrl = URL.createObjectURL(blob);
                    setMessages((prev) => [
                      ...prev,
                      {
                        userId: data.clientId,
                        text: `Файл "${data.fileName}" получен. `,
                        fileUrl,
                      },
                    ]);
                  } else {
                    // Если сообщение не для вас — можно его проигнорировать или обработать по-другому
                    console.log(
                      "Приватный файл не для этого клиента, оно адресовано:",
                      data.recipientId
                    );
                    return;
                  }
                } else {
                  // Групповой чат: сообщение передаётся в открытом виде
                  fileData = data.encryptedFile;
                }
              } catch (error) {
                console.error(`Ошибка обработки файла`);
              }
            }
          } catch (err) {
            console.error("Ошибка обработки входящего сообщения:", err.message);
          }
        };
        wsRef.current.onerror = (err) => {
          console.error("WebSocket error:", err, err.message);
          toast.error("Ошибка WebSocket-соединения");
        };
        wsRef.current.onclose = (event) => {
          console.log("WebSocket connection closed", event, event.message);
          wsRef.current = null;
          toast.info("Соединение с сервером закрыто");
        };
      } catch (err) {
        console.error("Ошибка инициализации чата:", err);
        toast.error("Ошибка инициализации чата");
      }
    };

    initChat();

    // Очистка при размонтировании компонента
    return () => {
      if (wsRef.current) {
        console.log("Закрытие WebSocket-соединения при размонтировании.");
        wsRef.current.close();
      }
    };
  }, [passphrase, chatType]);

  // Функция отправки сообщения (текстового)
  const sendMessage = async (message) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error("WebSocket не подключен");
      toast.error("WebSocket не подключен");
      return;
    }

    let messageToSend = message;
    if (chatType === "private") {
      // Если приватный чат – шифруем сообщение
      if (!keys.recipientPublicKey) {
        console.error("Публичный ключ получателя отсутствует");
        toast.error("Публичный ключ получателя отсутствует");
        return;
      }
      messageToSend = (
        await encryptMessage(message, keys.recipientPublicKey)
      ).trim();
      if (
        !messageToSend.startsWith("-----BEGIN PGP MESSAGE-----") ||
        !messageToSend.endsWith("-----END PGP MESSAGE-----")
      ) {
        console.error("Неверный формат зашифрованного сообщения");
        toast.error("Неверный формат зашифрованного сообщения");
        return;
      }
    }
    if (typeof message !== "string") {
      try {
        message = JSON.stringify(message);
        console.log("Преобразовано в строку:", message);
      } catch (err) {
        console.error("Не удалось преобразовать сообщение в строку:", err);
        toast.error("Ошибка преобразования сообщения");
        return;
      }
    }
    if (message.trim() === "") {
      console.error("Сообщение пустое");
      toast.error("Сообщение пустое");
      return;
    }
    try {
      const currentClientId = localStorage.getItem("clientId");
      const trimmedEncrypted = messageToSend.trim();
      wsRef.current.send(
        JSON.stringify({
          type: "message",
          encryptedMessage: trimmedEncrypted,
          clientId: currentClientId,
          ...(chatType === "private" && { recipientId: confirmedRecipientId }),
        })
      );
      setMessages((prev) => [...prev, { userId: "Вы", text: message }]);
      setInput("");
      toast.success("Сообщение отправлено");
    } catch (err) {
      console.error("Ошибка отправки сообщения:", err);
      toast.error("Ошибка отправки сообщения");
    }
  };
  // Функция отправки файла с шифрованием
  const sendFile = async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error("WebSocket не подключен");
      toast.error("WebSocket не подключен");
      return;
    }
    if (!file) {
      toast.error("Файл не выбран");
      return;
    }
    if (chatType === "private" && !keys.recipientPublicKey) {
      toast.error("Публичный ключ получателя отсутствует");
      return;
    }
    try {
      // Чтение файла как ArrayBuffer
      const fileBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (err) => reject(err);
        reader.readAsArrayBuffer(file);
      });
      let encryptedFile;
      if (chatType === "private") {
        encryptedFile = await openpgp.encrypt({
          message: await openpgp.createMessage({
            binary: new Uint8Array(fileBuffer),
          }),
          encryptionKeys: await openpgp.readKey({
            armoredKey: keys.recipientPublicKey,
          }),
        });
      } else {
        encryptedFile = fileBuffer;
      }

      // Формируем объект сообщения с метаданными файла
      const fileMessage = {
        type: "file",
        clientId: localStorage.getItem("clientId"),
        fileName: file.name,
        fileType: file.type,
        encryptedFile, 
        recipientId: chatType === "private" ? confirmedRecipientId : undefined,
        timestamp: new Date().toISOString(),
      };

      wsRef.current.send(JSON.stringify(fileMessage));
      setMessages((prev) => [
        ...prev,
        { userId: "Вы", text: `Файл "${file.name}" отправлен` },
      ]);
      setFile(null);
      toast.success("Файл отправлен");
    } catch (err) {
      console.error("Ошибка отправки файла:", err);
      toast.error("Ошибка отправки файла");
    }
  };
  // Обработчик выбора файла (если потребуется отправка файла)
  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  };
  return (
    <div className="chat-container">
      <h1>Anonymous Chat</h1>
      <button onClick={clearUserData} className="clear-btn">
        Очистить данные аккаунта
      </button>
      {/* Кнопка для восстановления доступа к аккаунту (сброс clientId и ключей) */}
      <button onClick={recoverAccount} className="recovery-btn">
        Восстановить аккаунт
      </button>
      {/* Переключатель типа чата: групповый или приватный */}
      <div className="chat-type">
        <label>
          <input
            type="radio"
            name="chatType"
            value="group"
            checked={chatType === "group"}
            onChange={() => setChatType("group")}
          />
          Групповой чат
        </label>
        <label>
          <input
            type="radio"
            name="chatType"
            value="private"
            checked={chatType === "private"}
            onChange={() => setChatType("private")}
          />
          Приватный чат
        </label>
      </div>
      {/* Если выбран приватный чат, поле для ввода ID собеседника */}
      {chatType === "private" && (
        <div>
          <button onClick={() => setShowRecipientInput((prev) => !prev)}>
            {showRecipientInput ? "Скрыть поле ввода" : "Ввести ID собеседника"}
          </button>
          {showRecipientInput && (
            <div>
              <input
                type="text"
                value={recipientId}
                onChange={(e) => setRecipientId(e.target.value)}
                placeholder="Введите ID собеседника"
                className="recipient-input"
              />
              <button onClick={confirmRecipient}>Подтвердить получателя</button>
            </div>
          )}
        </div>
      )}
      <div className="messages">
        {messages.map((msg, index) => (
          <p key={index} className="message">
            <strong>{msg.userId}:</strong> {msg.text}
            {msg.fileUrl && (
              <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer">
                Скачать файл
              </a>
            )}
          </p>
        ))}
      </div>
      <div className="input-area">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Введите сообщение..."
          className="text-input"
        />
        {/* Если нужно отправлять файлы */}
        <input type="file" onChange={handleFileChange} className="file-input" />
        <button
          onClick={() => sendMessage(input)}
          disabled={chatType === "private" && !confirmedRecipientId}
        >
          Отправить
        </button>
        <button onClick={sendFile} disabled={!file}>
          Отправить файл
        </button>
      </div>
      {/* Компонент видеозвонков */}
      <VideoChat
        ws={wsRef.current}
        clientId={localStorage.getItem("clientId")}
      />
      <ToastContainer position="bottom-right" autoClose={3000} />
    </div>
  );
};

export default Chat;
