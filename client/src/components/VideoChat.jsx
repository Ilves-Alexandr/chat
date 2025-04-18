// VideoChat.jsx
import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";

// Функции для пользовательского шифрования/дешифрования с AES-GCM

// Генерируем симметричный ключ для медиаданных (для демонстрации)
// В реальной схеме ключ нужно безопасно обменивать между участниками звонка
async function generateMediaKey() {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(data, key, iv) {
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
}

async function decryptData(data, key, iv) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}

// Получаем случайный IV фиксированной длины (12 байт)
function getRandomIV() {
  return crypto.getRandomValues(new Uint8Array(12));
}

const VideoChat = ({ ws, clientId }) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle"); // idle, calling, in_call
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const mediaKeyRef = useRef(null);

  // Конфигурация ICE серверов (STUN/TURN)
  const iceServers = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };
  // Функция установки insertable streams для отправителей (шифрование)
  const setupSenderTransform = (pc) => {
    if (pc.getSenders) {
      pc.getSenders().forEach((sender) => {
        // Для видео дорожки (аналогично можно для аудио)
        if (sender.track && sender.track.kind === "video") {
          // Проверяем поддержку метода createEncodedStreams
          if (sender.createEncodedStreams) {
            const senderStreams = sender.createEncodedStreams();
            const { readable, writable } = senderStreams;

            // Создаем TransformStream для шифрования
            const encryptTransform = new TransformStream({
              async transform(encodedFrame, controller) {
                // encodedFrame.data - ArrayBuffer
                const iv = getRandomIV();
                try {
                  const encryptedBuffer = await encryptData(
                    encodedFrame.data,
                    mediaKeyRef.current,
                    iv
                  );
                  // Создадим новый ArrayBuffer: сначала IV, затем зашифрованные данные
                  const ivArray = new Uint8Array(iv);
                  const encryptedArray = new Uint8Array(encryptedBuffer);
                  const combined = new Uint8Array(
                    ivArray.length + encryptedArray.length
                  );
                  combined.set(ivArray, 0);
                  combined.set(encryptedArray, ivArray.length);
                  encodedFrame.data = combined.buffer;
                  controller.enqueue(encodedFrame);
                } catch (e) {
                  console.error("Ошибка шифрования кадра:", e);
                }
              },
            });
            readable.pipeThrough(encryptTransform).pipeTo(writable);
            console.log(
              "Настроен transform stream для отправителя",
              sender.track.kind
            );
          }
        }
      });
    }
  };

  // Функция установки insertable streams для получателей (дешифрование)
  const setupReceiverTransform = (pc) => {
    if (pc.getReceivers) {
      pc.getReceivers().forEach((receiver) => {
        if (receiver.track && receiver.track.kind === "video") {
          if (receiver.createEncodedStreams) {
            const receiverStreams = receiver.createEncodedStreams();
            const { readable, writable } = receiverStreams;

            const decryptTransform = new TransformStream({
              async transform(encodedFrame, controller) {
                // Извлекаем iv и зашифрованные данные:
                const dataArray = new Uint8Array(encodedFrame.data);
                // Предполагаем, что IV – 12 байт
                const iv = dataArray.slice(0, 12);
                const encryptedData = dataArray.slice(12).buffer;
                try {
                  const decryptedBuffer = await decryptData(
                    encryptedData,
                    mediaKeyRef.current,
                    iv
                  );
                  encodedFrame.data = decryptedBuffer;
                  controller.enqueue(encodedFrame);
                } catch (e) {
                  console.error("Ошибка дешифровки кадра:", e);
                }
              },
            });
            readable.pipeThrough(decryptTransform).pipeTo(writable);
            console.log(
              "Настроен transform stream для получателя",
              receiver.track.kind
            );
          }
        }
      });
    }
  };
  // Функция отправки SDP offer с повторными попытками (с использованием useCallback для мемоизации)
  const sendOffer = useCallback(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "video_signal",
          signalType: "video_offer",
          offer: peerConnectionRef.current.localDescription,
          clientId,
        })
      );
      console.log("SDP offer отправлен");
    } else {
      console.warn(
        "WebSocket не готов, повторная отправка offer через 2 секунды"
      );
      setTimeout(sendOffer, 2000);
    }
  }, [ws, clientId]);

  // Функция начала звонка
  const startCall = async () => {
    try {
      // Генерируем симметричный ключ для медиаданных, если ещё не создан
      if (!mediaKeyRef.current) {
        mediaKeyRef.current = await generateMediaKey();
        console.log("Media key сгенерирован");
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      console.log("Все устройства:", devices);
      const videoInputDevices = devices.filter(
        (device) => device.kind === "videoinput"
      );
      console.log("Видеоустройства:", videoInputDevices);
      const audioInputDevices = devices.filter(
        (device) => device.kind === "audioinput"
      );
      console.log("Аудиоустройства:", audioInputDevices);

      if (videoInputDevices.length === 0) {
        throw new Error(
          "Веб-камера не найдена. Пожалуйста, подключите веб-камеру."
        );
      }
      if (audioInputDevices.length === 0) {
        throw new Error("Микрофон не найден. Пожалуйста, подключите микрофон.");
      }

      // Запрашиваем доступ к камере и микрофону
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      // Создаем RTCPeerConnection и добавляем все дорожки локального потока
      const pc = new RTCPeerConnection(iceServers);
      peerConnectionRef.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      // Применяем шифрование для отправителей (insertable streams)
      setupSenderTransform(pc);
      // Обработка ICE кандидатов: отправляем их через WebSocket
      pc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "video_signal",
              signalType: "ice_candidate",
              candidate: event.candidate,
              clientId,
            })
          );
        }
      };
      // При получении удаленного потока, отображаем его
      pc.ontrack = (event) => {
        if (remoteVideoRef.current) {
          setupReceiverTransform(pc);
          remoteVideoRef.current.srcObject = event.streams[0];
          setRemoteStream(event.streams[0]);
        }
      };
      // Создаем SDP offer и устанавливаем локальное описание
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Отправляем offer через WebSocket с повторными попытками, если нужно
      const sendOfferWithRetry = () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "video_signal",
              signalType: "video_offer",
              offer,
              clientId,
            })
          );
          console.log("SDP offer отправлен");
        } else {
          console.warn(
            "WebSocket не готов, повторная отправка offer через 2 секунды"
          );
          setTimeout(sendOffer, 2000);
        }
      };
      sendOfferWithRetry();
      setCallStatus("calling");
    } catch (err) {
      console.error("Ошибка запуска видеозвонка:", err);
      toast.error(`Ошибка запуска видеозвонка: ${err.message}`);
    }
  };

  // Функция обработки входящего SDP offer
  const handleOffer = useCallback(
    async (data) => {
      try {
        if (!mediaKeyRef.current) {
          mediaKeyRef.current = await generateMediaKey();
          console.log("Media key сгенерирован (при получении offer)");
        }
        const pc = new RTCPeerConnection(iceServers);
        peerConnectionRef.current = pc;
        // Запрашиваем доступ к локальному потоку
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        setLocalStream(stream);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        setupSenderTransform(pc);
        pc.onicecandidate = (event) => {
          if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "video_signal",
                signalType: "ice_candidate",
                candidate: event.candidate,
                clientId,
              })
            );
          }
        };

        pc.ontrack = (event) => {
          if (remoteVideoRef.current) {
            setupReceiverTransform(pc);
            remoteVideoRef.current.srcObject = event.streams[0];
            setRemoteStream(event.streams[0]);
          }
        };
        // Устанавливаем удалённое описание (offer)
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        // Создаем ответ (answer) и устанавливаем его как локальное описание
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "video_signal",
              signalType: "video_answer",
              answer,
              clientId,
            })
          );
        }
        setCallStatus("in_call");
      } catch (err) {
        console.error("Ошибка обработки входящего offer:", err);
        toast.error(`Ошибка обработки входящего offer: ${err.message}`);
      }
    },
    [ws, clientId, iceServers]
  );

  // Функция обработки входящего SDP answer
  const handleAnswer = async (data) => {
    try {
      await peerConnectionRef.current.setRemoteDescription(
        new RTCSessionDescription(data.answer)
      );
      setCallStatus("in_call");
    } catch (err) {
      console.error("Ошибка обработки ответа:", err);
    }
  };

  // Функция обработки ICE кандидатов
  const handleICECandidate = async (data) => {
    try {
      if (data.candidate) {
        await peerConnectionRef.current.addIceCandidate(
          new RTCIceCandidate(data.candidate)
        );
      }
    } catch (err) {
      console.error("Ошибка добавления ICE кандидата:", err);
      toast.error(`Ошибка добавления ICE кандидата: ${err.message}`);
    }
  };

  // Обработка сигналов видеозвонка через CustomEvent
  useEffect(() => {
    const signalHandler = (e) => {
      const data = e.detail;
      if (data.signalType === "video_offer") {
        handleOffer(data);
      } else if (data.signalType === "video_answer") {
        handleAnswer(data);
      } else if (data.signalType === "ice_candidate") {
        handleICECandidate(data);
      }
    };
    document.addEventListener("videoSignal", signalHandler);
    return () => {
      document.removeEventListener("videoSignal", signalHandler);
    };
  }, [handleOffer]); // Добавляем handleOffer как зависимость

  // Переключение аудио (вкл/выкл микрофон)
  const toggleAudio = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setAudioEnabled((prev) => !prev);
    }
  };

  // Переключение видео (вкл/выкл камеру)
  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setVideoEnabled((prev) => !prev);
    }
  };

  // Завершение звонка: закрытие соединения и остановка всех потоков
  const endCall = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }
    if (remoteStream) {
      remoteStream.getTracks().forEach((track) => track.stop());
      setRemoteStream(null);
    }
    setCallStatus("idle");
  };

  return (
    <div className="video-chat-container">
      <h2>Video Chat</h2>
      {callStatus === "idle" ? (
        <button onClick={startCall}>Начать звонок</button>
      ) : (
        <button onClick={endCall}>Завершить звонок</button>
      )}
      <button onClick={toggleAudio}>
        {audioEnabled ? "Выключить микрофон" : "Включить микрофон"}
      </button>
      <button onClick={toggleVideo}>
        {videoEnabled ? "Выключить камеру" : "Включить камеру"}
      </button>
      <div className="video-container">
        <div className="local-video">
          <h3>Ваше видео</h3>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            style={{ width: "100%" }}
          />
        </div>
        <div className="remote-video">
          <h3>Видео собеседника</h3>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{ width: "100%" }}
          />
        </div>
      </div>
      <ToastContainer position="bottom-right" autoClose={3000} />
    </div>
  );
};

export default VideoChat;
