import React, { useEffect, useState, useRef, useCallback } from "react";
import { ReactComponent as MoonIcon } from "../assets/icons/moon.svg";
import { ReactComponent as PaperAirplaneIcon } from "../assets/icons/paper-airplane.svg";
import { ReactComponent as PaperClipIcon } from "../assets/icons/paper-clip.svg";
// import { ReactComponent as PhoneXMarkIcon } from "../assets/icons/phone-x-mark.svg";
// import { ReactComponent as PhoneIcon } from "../assets/icons/phone.svg";
// import { ReactComponent as SpeakerWaveIcon } from "../assets/icons/speaker-wave.svg";
// import { ReactComponent as SpeakerXMarkIcon } from "../assets/icons/speaker-x-mark.svg";
// import { ReactComponent as VideoCameraIcon } from "../assets/icons/video-camera.svg";
import { ReactComponent as SunIcon } from "../assets/icons/sun.svg";
import { ReactComponent as TrashIcon } from "../assets/icons/trash.svg";
import { ReactComponent as ArchiveBoxIcon } from "../assets/icons/archive-box.svg";


// import { ReactComponent as VideoCameraSlashIcon } from "../assets/icons/video-camera-slash.svg";
import * as openpgp from "openpgp";
import { v4 as uuidv4 } from "uuid";
import {
  generateKeys,
  encryptMessage,
  decryptMessage,
  decryptFile,
  storePrivateKey,
  retrievePrivateKey,
  initializeDB,
} from "../utils/crypto";
import {
  base64ToArrayBuffer,
  arrayBufferToBase64,
  encryptPrivateKey,
  decryptPrivateKey,
} from "../utils/cryptoProtection";
// import { sha256 } from "js-sha256"; // Пока не используется
import VideoChat from "./VideoChat";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./Chat.css";

const Chat = () => {
  // --- ТЕМА ---
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    document.body.classList.toggle("dark-mode", darkMode);
  }, [darkMode]);

  // --- ВЫБОР ФАЙЛА ---
  const [fileName, setFileName] = useState("Файл не выбран");
  const [file, setFile] = useState(null);
  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    setFile(f || null);
    setFileName(f ? f.name : "Файл не выбран");
  };
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
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

  // Функция для подтверждения введённого идентификатора собеседника
  const confirmRecipient = () => {
    if (!recipientId.trim()) {
      toast.error("Введите корректный идентификатор собеседника");
      return;
    }
    setConfirmedRecipientId(recipientId.trim());
    toast.success(`Получатель подтверждён: ${recipientId.trim()}`);
  };

  const safeDecryptMessage = async (
    encryptedMessage,
    privateKey,
    passphrase
  ) => {
    if (
      typeof encryptedMessage !== "string" ||
      !encryptedMessage.startsWith("-----BEGIN PGP MESSAGE-----")
    ) {
      throw new Error(
        "Полученное сообщение не является корректным PGP-сообщением"
      );
    }
    return await decryptMessage(encryptedMessage, privateKey, passphrase);
  };
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
  const handleSend = async () => {
    // Сначала отправляем файл (если выбран)
    if (file) {
      await sendFile();
    }
    // Затем отправляем текст (если есть непустой ввод)
    if (input.trim() !== "") {
      await sendMessage(input);
    }
  };
  useEffect(() => {
    const initChat = async () => {
      try {
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
        let privateKey;
        let publicKey;
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
            if (typeof data !== "string") {
              data = data.toString();
              console.warn(
                "Полученное сообщение не является строкой, преобразуем его к строке"
              );
            }
            data = JSON.parse(data);
            console.log("Получено сообщение от сервера:", data);
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
                if (data.recipientId) {
                  if (data.recipientId === clientId) {
                    text = await safeDecryptMessage(
                      data.encryptedMessage,
                      privateKeyRef.current,
                      passphrase
                    );
                  } else {
                    console.log(
                      "Приватное сообщение не для этого клиента, оно адресовано:",
                      data.recipientId
                    );
                    return;
                  }
                } else {
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
              let fileData;
              try {
                if (typeof data.encryptedFile === "string") {
                  if (
                    data.encryptedFile.startsWith("-----BEGIN PGP MESSAGE-----")
                  ) {
                    fileData = await decryptFile(
                      data.encryptedFile,
                      privateKeyRef.current,
                      passphrase
                    );
                  } else if (data.encryptedFile.trim().length > 0) {
                    fileData = new Uint8Array(
                      base64ToArrayBuffer(data.encryptedFile)
                    );
                  } else {
                    throw new Error("Пустое поле encryptedFile");
                  }
                } else {
                  throw new Error("Неверный тип поля encryptedFile");
                }
                const blob = new Blob([fileData], { type: data.fileType });
                const fileUrl = URL.createObjectURL(blob);
                setMessages((prev) => [
                  ...prev,
                  {
                    userId: data.clientId,
                    text: `Файл "${data.fileName}" получен.`,
                    fileUrl,
                  },
                ]);
              } catch (error) {
                console.error("Ошибка обработки файла:", error);
                toast.error("Ошибка обработки файла");
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

  const sendMessage = async (message) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error("WebSocket не подключен");
      toast.error("WebSocket не подключен");
      return;
    }

    let messageToSend = message;
    if (chatType === "private") {
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
          format: "armored",
        });
      } else {
        encryptedFile = arrayBufferToBase64(fileBuffer);
      }
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
  return (
    <div className="chat-container">
      <div className="top_group">
        {/* Переключатель темы */}
        <label htmlFor="darkToggle" className="theme-toggle">
          <input
            className="darkToggle"
            id="darkToggle"
            type="checkbox"
            checked={darkMode}
            onChange={(e) => setDarkMode(e.target.checked)}
          />
          {!darkMode && <MoonIcon className="moon_icon" />}
          {darkMode && <SunIcon className="sun_icon" />}
        </label>
        <div className="acc">
          <button onClick={clearUserData} className="clear-btn btn">
            <TrashIcon className="trash_icon"/>
          </button>
          {/* Кнопка для восстановления доступа к аккаунту (сброс clientId и ключей) */}
          <button onClick={recoverAccount} className="recovery-btn btn">
            <ArchiveBoxIcon className="archive-box_icon" />
          </button>
        </div>
      </div>
      <h1>Чат</h1>
      {/* Переключатель типа чата: групповый или приватный */}
      <div className="chat-type">
        {chatType === "private" && (
          <div className="label-text">Приватный чат</div>
        )}
        {chatType !== "private" && (
          <div className="label-text">Мировой чат</div>
        )}
          <label className="switch">
            <input
              type="checkbox"
              checked={chatType === "private"}
              onChange={() =>
                setChatType((prev) => (prev === "group" ? "private" : "group"))
              }
            />
            <span className="slider"></span>
          </label>
        {/* Если выбран приватный чат, поле для ввода ID собеседника */}
        {chatType === "private" && (
          <div className="recipient">
            <button
              className="recipient_btn btn"
              onClick={() => setShowRecipientInput((prev) => !prev)}
            >
              {showRecipientInput
                ? "Скрыть поле ввода"
                : "Ввести ID собеседника"}
            </button>
            {showRecipientInput && (
              <div>
                <input
                  type="text"
                  value={recipientId}
                  onChange={(e) => setRecipientId(e.target.value)}
                  placeholder="Введите ID собеседника"
                  className="recipient-input input"
                />
                <button className="btn" onClick={confirmRecipient}>
                  Подтвердить получателя
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="view_data">
        <div className="video">
          {chatType === "private" && (
            <VideoChat
              ws={wsRef.current}
              clientId={localStorage.getItem("clientId")}
              recipientId={confirmedRecipientId}
            />
          )}
        </div>
        <div className="messages">
          {messages.map((msg, index) => (
            <p key={index} className="message">
              <strong>{msg.userId}:</strong> {msg.text}
              {chatType === "private" && msg.fileUrl && (
                <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer">
                  <PaperClipIcon className="paper-clip_icon" />
                </a>
              )}
            </p>
          ))}
        </div>
      </div>
      <div className="bottom_group">
        <div className="bottom_group-item">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Введите сообщение или прикрепите файл"
            className="text_input input"
            id="text_input"
          />
         {chatType === "private" && (
            <div className="file_container">
              {/* Привязанная к input type="file" иконка */}
              <label htmlFor="fileInput" className="file_label">
                <input
                  type="file"
                  id="fileInput"
                  onChange={handleFileChange}
                  className="file-input"
                />
                <PaperClipIcon className="paper-clip_icon" />
              </label>
            </div>
          )}
        </div>
        <div className="bottom_group-item">
          <div className="text_btn-container">
            {/* Одна общая кнопка отправки */}
            <button
              id="text_btn"
              className="text_btn btn"
              onClick={handleSend}
              disabled={
                (chatType === "private" && !confirmedRecipientId) || // приватный без получателя
                (!file && input.trim() === "") // нет ни текста, ни файла
              }
            >
              <PaperAirplaneIcon className="paper-air-plane_icon" />
            </button>
          </div>
        </div>
      </div>
      {/* <ToastContainer position="bottom-right" autoClose={3000} /> */}
    </div>
  );
};

export default Chat;
