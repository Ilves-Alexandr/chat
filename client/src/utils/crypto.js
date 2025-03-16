import * as openpgp from 'openpgp';// Импорт библиотеки OpenPGP для шифрования/дешифрования

// 📌 Генерация пары PGP-ключей (приватного и публичного)
export const generateKeys = async () => {
  const { privateKey, publicKey } = await openpgp.generateKey({
    userIDs: [{ name: 'Anonymous' }], // Устанавливаем имя пользователя
    curve: 'ed25519', // Используем современную криптографическую кривую Ed25519
  });
  return { privateKey, publicKey }; // Возвращаем сгенерированные ключи
};

// 📌 Функция для шифрования сообщения с использованием публичного ключа получателя
export const encryptMessage = async (message, publicKey) => {
  const encrypted = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: message }), // Создаём объект сообщения
    encryptionKeys: await openpgp.readKey({ armoredKey: publicKey }), // Загружаем публичный ключ
  });
  return encrypted; // Возвращаем зашифрованное сообщение
};

// 📌 Функция для расшифровки сообщения с использованием приватного ключа
export const decryptMessage = async (encryptedMessage, privateKey) => {
  const decrypted = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: encryptedMessage }), // Загружаем зашифрованное сообщение
    decryptionKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }), // Загружаем приватный ключ
  });
  return decrypted.data; // Возвращаем расшифрованное сообщение
};
// 📌 Инициализация базы данных IndexedDB для хранения приватных ключей
export const initializeDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('chatAppDB', 1);  // Открываем базу данных 'chatAppDB' версии 1

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('keys')) {
        // Создаём хранилище для ключей
        db.createObjectStore('keys', { keyPath: 'id' }); // Создаём хранилище объектов "keys"
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);  // Успешное открытие базы данных
    };

    request.onerror = (event) => {
      reject(event.target.error); // Ошибка при открытии базы
    };
  });
};
// 📌 Функция для сохранения приватного ключа в IndexedDB
export const storePrivateKey = async (privateKey) => {
  const db = await initializeDB(); // Инициализируем базу
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('keys', 'readwrite'); // Открываем транзакцию для записи
    const store = transaction.objectStore('keys'); // Доступ к хранилищу
    const request = store.put({ id: 'privateKey', key: privateKey }); // Сохраняем приватный ключ

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
};
// 📌 Функция для загрузки приватного ключа из IndexedDB
export const retrievePrivateKey = async () => {
  const db = await initializeDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('keys', 'readonly'); // Открываем транзакцию только для чтения
    const store = transaction.objectStore('keys');
    const request = store.get('privateKey'); // Достаём ключ по ID

    request.onsuccess = () => {
      resolve(request.result ? request.result.key : null); // Если ключ найден, возвращаем его
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
};

