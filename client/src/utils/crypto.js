import * as openpgp from "openpgp"; // Импорт библиотеки OpenPGP для шифрования/дешифрования
// 📌 Генерация пары PGP-ключей (приватного и публичного)
export const generateKeys = async (passphrase) => {
  const { privateKey, publicKey } = await openpgp.generateKey({
    userIDs: [{ name: "Anonymous" }], // Устанавливаем имя пользователя
    curve: "ed25519",
    passphrase, // Используем современную криптографическую кривую Ed25519
  });
  return { privateKey, publicKey }; // Возвращаем сгенерированные ключи
};

// Функция для шифрования сообщения с использованием публичного ключа получателя
export const encryptMessage = async (message, publicKey) => {
  const pgpMessage = await openpgp.createMessage({ text: message });
  const pubKey = await openpgp.readKey({ armoredKey: publicKey });
  const encrypted = await openpgp.encrypt({
    message: pgpMessage,
    encryptionKeys: pubKey,
    format: "armored",
  });
  return encrypted;
};

// Функция для расшифровки сообщения с использованием приватного ключа
export const decryptMessage = async (encryptedMessage, privateKey, passphrase) => {
  const privKey = await openpgp.readPrivateKey({ armoredKey: privateKey });
  let decryptionKey;
  try {
    // Пытаемся расшифровать ключ, если он ещё зашифрован
    decryptionKey = await openpgp.decryptKey({ privateKey: privKey, passphrase });
  } catch (error) {
    // Если возникает ошибка, можно предположить, что ключ уже расшифрован
    console.log("Ключ, возможно, уже расшифрован:", error);
    decryptionKey = privKey;
  }
  const message = await openpgp.readMessage({ armoredMessage: encryptedMessage });
  const decrypted = await openpgp.decrypt({
    message,
    decryptionKeys: decryptionKey,
  });
  return decrypted.data;
};
export const decryptFile = async (encryptedFile, privateKey, passphrase) => {
  // Читаем приватный ключ
  const privKey = await openpgp.readPrivateKey({ armoredKey: privateKey });
  // Если ключ зашифрован, расшифровываем его
  let decryptionKey;
  try {
    decryptionKey = await openpgp.decryptKey({
      privateKey: privKey,
      passphrase,
    });
  } catch (error) {
    console.warn("Ключ, возможно, уже расшифрован:", error);
    decryptionKey = privKey;
  }
  // Читаем зашифрованное сообщение
  const message = await openpgp.readMessage({
    armoredMessage: encryptedFile,
  });
  // Дешифруем сообщение в бинарном формате
  const decrypted = await openpgp.decrypt({
    message,
    decryptionKeys: decryptionKey,
    format: "binary", // возвращаем бинарные данные
  });
  return decrypted.data; // будет Uint8Array
};
// 📌 Инициализация базы данных IndexedDB для хранения приватных ключей
export const initializeDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("chatAppDB", 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("keys")) {
        db.createObjectStore("keys", { keyPath: "id" });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
};
// 📌 Функция для сохранения приватного ключа в IndexedDB
export const storePrivateKey = async (privateKey) => {
  const db = await initializeDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("keys", "readwrite"); // Открываем транзакцию для записи
    const store = transaction.objectStore("keys"); // Доступ к хранилищу
    const request = store.put({ id: "privateKey", key: privateKey }); // Сохраняем приватный ключ
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
};
// 📌 Функция для загрузки приватного ключа из IndexedDB
export const retrievePrivateKey = async (passphrase) => {
  console.log("Переданный passphrase для дешифровки:", passphrase);
  const db = await initializeDB();
  console.dir(`await initializeDB()::${db}`);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("keys", "readonly");
    const store = transaction.objectStore("keys");
    const request = store.get("privateKey");
    console.log("Попытка загрузить приватный ключ из IndexedDB...");
    request.onsuccess = async () => {
      if (!request.result) {
        console.error("Приватный ключ не найден в IndexedDB.");
        reject("Приватный ключ не найден");
        return;
      }
      console.log("Найден зашифрованный ключ:", request.result.key);
      try {
        console.log("Используемый passphrase перед дешифровкой:", passphrase);
        const privKey = await openpgp.readPrivateKey({
          armoredKey: request.result.key,
        });
        const decryptedPrivKey = await openpgp.decryptKey({ privateKey: privKey, passphrase });
        console.log("Дешифрованный приватный ключ успешно получен.");
        console.log("retrievePrivateKey - Расшифрованный ключ:", decryptedPrivKey.armor());
        resolve(decryptedPrivKey.armor());
      } catch (error) {
        console.error("Ошибка дешифровки приватного ключа. Возможно, неверная passphrase?", error);
        reject("Ошибка расшифровки приватного ключа. Неверный passphrase?");
      }
    };

    request.onerror = (event) => {
      console.error("Ошибка при доступе к IndexedDB:", event.target.error);
      reject(event.target.error);
    };
  });
};
