// utils/cryptoProtection.js

/**
 * Преобразует строку в Uint8Array.
 */
const strToUint8Array = (str) => new TextEncoder().encode(str);

/**
 * Преобразует Uint8Array в строку.
 */
const uint8ArrayToStr = (arr) => new TextDecoder().decode(arr);

/**
 * Преобразует ArrayBuffer в Base64 строку.
 */
export const arrayBufferToBase64 = (buffer) => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return window.btoa(binary);
};

/**
 * Преобразует Base64 строку в ArrayBuffer.
 */
export const base64ToArrayBuffer = (base64) => {
  // Убираем пробелы и переносы строк
  const cleanBase64 = base64.replace(/\s/g, "");
  try {
    const binary = window.atob(cleanBase64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } catch (err) {
    console.error("Ошибка преобразования Base64:", base64, err);
    throw err;
  }
};

/**
 * Производит вывод криптографического ключа из фразы с использованием PBKDF2.
 */
const deriveKey = async (passphrase, salt) => {
  console.log(`passphrase переданный в функции deriveKey::${passphrase}`);
  
  const baseKey = await window.crypto.subtle.importKey(
    "raw",
    strToUint8Array(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

/**
 * Шифрует текст (например, приватный ключ) с использованием AES-GCM.
 * @param {string} plainText – исходный текст для шифрования.
 * @param {string} passphrase – фраза-пароль для генерации ключа.
 * @returns {Promise<string>} – зашифрованный текст в формате Base64, включающий iv.
 */
export const encryptPrivateKey = async (plainText, passphrase) => {
  console.log(`plainText::${plainText}`);
  console.log(`passphrase переданный в функции encryptPrivateKey::${passphrase}`);
  // Генерируем случайную соль (16 байт) и IV (12 байт)
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  console.log(`encryptPrivateKey_func_salt::`, salt);
  console.log(`encryptPrivateKey_func_iv::`, iv);
  const key = await deriveKey(passphrase, salt);
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    strToUint8Array(plainText)
  );
  // Кодируем соль, iv и зашифрованные данные в Base64 и объединяем через разделитель
  return `${arrayBufferToBase64(salt)}:${arrayBufferToBase64(
    iv
  )}:${arrayBufferToBase64(encryptedBuffer)}`;
};

/**
 * Дешифрует зашифрованный текст с использованием AES-GCM.
 * @param {string} encryptedData – зашифрованные данные в формате Base64 (salt:iv:ciphertext).
 * @param {string} passphrase – фраза-пароль.
 * @returns {Promise<string>} – расшифрованный исходный текст.
 */

export const decryptPrivateKey = async (encryptedData, passphrase) => {
  console.log(`encryptedData::${encryptedData}`);
  console.log(`passphrase переданный в функции decryptPrivateKey::${passphrase}`);
  const parts = encryptedData.split(":");
  console.log(`parts::${parts}`);
  if (parts.length !== 3) {
    throw new Error("Неверный формат зашифрованного ключа");
  }
  const [saltB64, ivB64, dataB64] = parts;
  // Проверяем каждую часть
  console.log("Salt Base64:", saltB64);
  console.log("IV Base64:", ivB64);
  console.log("Ciphertext Base64:", dataB64);
  const salt = new Uint8Array(base64ToArrayBuffer(saltB64));
  const iv = new Uint8Array(base64ToArrayBuffer(ivB64));
  const ciphertext = base64ToArrayBuffer(dataB64);
  console.log(`decryptPrivateKey_func_salt::${salt}`);
  console.log(`decryptPrivateKey_func_iv::${iv}`);
  console.log(`decryptPrivateKey_func_ciphertext::${ciphertext}`);
  const key = await deriveKey(passphrase, salt);
  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return uint8ArrayToStr(new Uint8Array(decryptedBuffer));
};
