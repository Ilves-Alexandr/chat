import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";

// =================== AES-GCM помощники ===================
async function generateMediaKey() {
  // Генерация симметричного ключа для шифрования медиа-данных
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(plainBuffer, key, iv) {
  // Шифруем ArrayBuffer с использованием AES-GCM
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBuffer);
}

async function decryptData(cipherBuffer, key, iv) {
  // Расшифровываем ArrayBuffer с использованием AES-GCM
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBuffer);
}

function getRandomIV() {
  // AES-GCM требует 12-байтовый IV
  return crypto.getRandomValues(new Uint8Array(12));
}

// =================== ICE серверы ===================
const iceConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:turn.example.com:3478",
      username: "user",
      credential: "pass",
    },
  ],
};

// =================== VideoChat ===================
export default function VideoChat({ ws, clientId, recipientId }) {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle"); // "idle" | "calling" | "in_call"

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const mediaKeyRef = useRef(null);
  const bufferedIce = useRef([]);

  // =================== Устанавливаем Sender-transform ===================
  const setupSenderTransform = (sender) => {
    if (!mediaKeyRef.current) {
      console.warn("⚠️ Sender трансформ пропущен: ключ ещё не готов");
      return;
    }
    if (!sender.createEncodedStreams || sender.track.kind !== "video") return;

    let streams;
    try {
      streams = sender.createEncodedStreams();
    } catch (err) {
      console.warn("🔐 Sender.createEncodedStreams не поддерживается:", err);
      return;
    }

    const { readable, writable } = streams;
    const transform = new TransformStream({
      async transform(frame, controller) {
        const iv = getRandomIV();
        try {
          const encrypted = await encryptData(frame.data, mediaKeyRef.current, iv);
          // объединяем IV + ciphertext
          const ivArr = new Uint8Array(iv);
          const encArr = new Uint8Array(encrypted);
          const combined = new Uint8Array(ivArr.byteLength + encArr.byteLength);
          combined.set(ivArr, 0);
          combined.set(encArr, ivArr.byteLength);
          frame.data = combined.buffer;
          controller.enqueue(frame);
        } catch (e) {
          console.error("🔐 Ошибка шифрования кадра:", e);
          controller.enqueue(frame); // даже при ошибке — передаём оригинал
        }
      },
    });
    readable.pipeThrough(transform).pipeTo(writable);
    console.log("✅ Sender трансформ установлен для", sender.track.id);
  };

  // =================== Устанавливаем Receiver-transform ===================
  const setupReceiverTransform = (receiver) => {
    if (!mediaKeyRef.current) {
      console.warn("⚠️ Receiver трансформ пропущен: ключ ещё не готов");
      return;
    }
    if (!receiver.createEncodedStreams || receiver.track.kind !== "video") {
      console.log("— Receiver не видео или нет API createEncodedStreams");
      return;
    }

    let streams;
    try {
      streams = receiver.createEncodedStreams();
    } catch (err) {
      console.warn("🔓 Receiver.createEncodedStreams не сработал:", err);
      return;
    }

    const { readable, writable } = streams;
    const transform = new TransformStream({
      async transform(frame, controller) {
        try {
          const dataArr = new Uint8Array(frame.data);
          const iv = dataArr.slice(0, 12);
          const cipher = dataArr.slice(12).buffer;
          const decrypted = await decryptData(cipher, mediaKeyRef.current, iv);
          frame.data = decrypted;
          controller.enqueue(frame);
        } catch (e) {
          console.error("🔓 Ошибка дешифровки кадра:", e);
          controller.enqueue(frame); // при ошибке — передаём зашифрованный
        }
      },
    });
    readable.pipeThrough(transform).pipeTo(writable);
    console.log("✅ Receiver трансформ установлен для", receiver.track.id);
  };

  // =================== WebSocket: общий слушатель ===================
  useEffect(() => {
    if (!ws) return;

    // Генерируем ключ сразу после монтирования
    (async () => {
      mediaKeyRef.current = await generateMediaKey();
      console.log("🔑 MediaKey готов");
    })();

    const onMessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "video_signal") return;

      const pc = pcRef.current;
      const { signalType } = msg;

      if (signalType === "video_offer") {
        // сразу принимаем входящий оффер
        await handleOffer(msg);
        return;
      }

      if (signalType === "video_answer" && pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        setCallStatus("in_call");
        return;
      }

      if (signalType === "ice_candidate" && pc) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (err) {
            console.warn("Не удалось добавить ICE:", err);
          }
        } else {
          // буферизуем до remoteDescription
          bufferedIce.current.push(msg.candidate);
        }
      }
    };

    ws.addEventListener("message", onMessage);
    return () => ws.removeEventListener("message", onMessage);
  }, [ws, handleOffer]);

  // =================== Начало звонка (инициатор) ===================
  const startCall = async () => {
    const pc = new RTCPeerConnection(iceConfig);
    pcRef.current = pc;

    // 1) локальные медиа
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    setLocalStream(stream);
    localVideoRef.current.srcObject = stream;

    // 2) добавляем треки + шифруем отправку
    stream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, stream);
      setupSenderTransform(sender);
    });

    // 3) ontrack для получения удалённых потоков
    pc.ontrack = (e) => {
      const [remote] = e.streams;
      setRemoteStream(remote);
      remoteVideoRef.current.srcObject = remote;
    };

    // 4) ICE кандидаты
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "ice_candidate",
            candidate: e.candidate,
            clientId,
            recipientId,
          })
        );
      }
    };

    // 5) создаём оффер только после addTrack
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(
      JSON.stringify({
        type: "video_signal",
        signalType: "video_offer",
        offer: pc.localDescription,
        clientId,
        recipientId,
      })
    );

    setCallStatus("calling");
  };

  // =================== Обработка входящего оффера ===================
  const handleOffer = useCallback(
    async ({ offer, clientId: from }) => {
      const pc = new RTCPeerConnection(iceConfig);
      pcRef.current = pc;

      // 1) получаем локальные треки до setRemoteDescription
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      localVideoRef.current.srcObject = stream;

      // 2) добавляем треки и шифруем
      stream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, stream);
        setupSenderTransform(sender);
      });

      // 3) ontrack до установки remoteDescription
      pc.ontrack = (e) => {
        const [remote] = e.streams;
        setRemoteStream(remote);
        remoteVideoRef.current.srcObject = remote;
      };

      // 4) ICE кандидаты
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(
            JSON.stringify({
              type: "video_signal",
              signalType: "ice_candidate",
              candidate: e.candidate,
              clientId,
              recipientId: from,
            })
          );
        }
      };

      // 5) принимаем оффер
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      // 6) отвечаем
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(
        JSON.stringify({
          type: "video_signal",
          signalType: "video_answer",
          answer: pc.localDescription,
          clientId,
          recipientId: from,
        })
      );

      // flush ICE
      bufferedIce.current.forEach(async (cand) => {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch {}
      });
      bufferedIce.current = [];

      setCallStatus("in_call");
    },
    [ws, clientId]
  );

  // =================== Завершение звонка ===================
  const endCall = () => {
    pcRef.current?.close();
    localStream?.getTracks().forEach((t) => t.stop());
    remoteStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus("idle");
    bufferedIce.current = [];
  };

  return (
    <div className="video-chat-container">
      <h2>Video Chat</h2>

      {callStatus === "idle" ? (
        <button onClick={startCall}>Начать звонок</button>
      ) : (
        <button onClick={endCall}>Завершить звонок</button>
      )}

      <div className="video-container">
        <div className="local-video">
          <h3>Ваше видео</h3>
          <video ref={localVideoRef} autoPlay muted playsInline />
        </div>
        <div className="remote-video">
          <h3>Видео собеседника</h3>
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
      </div>

      <ToastContainer position="bottom-right" autoClose={3000} />
    </div>
  );
}
