const openpgp = require('openpgp');

const generatePGPKeys = async () => {
  const userId = {
    name: 'Test User',       // Имя пользователя
    email: 'test@example.com', // Email пользователя
  };

  const options = {
    type: 'rsa',            // Тип ключа (RSA)
    rsaBits: 2048,          // Размер ключа в битах
    userIDs: [userId],      // Информация о пользователе
    passphrase: 'your-passphrase-here', // Пароль для защиты приватного ключа
  };

  try {
    const keyPair = await openpgp.generateKey(options);
    const { privateKey, publicKey } = keyPair;

    console.log('Публичный ключ:');
    console.log(publicKey);

    console.log('\nПриватный ключ:');
    console.log(privateKey);

    return { privateKey, publicKey };
  } catch (err) {
    console.error('Ошибка генерации ключей:', err.message);
  }
};

generatePGPKeys();
