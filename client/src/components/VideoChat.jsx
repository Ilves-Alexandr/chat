import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";

// AES-GCM helpers
async function generateKey() {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}
function getIv() {
  return crypto.getRandomValues(new Uint8Array(12));
}
async function encrypt(buf, key, iv) {
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf);
}
async function decrypt(buf, key, iv) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, buf);
}

const iceConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export default function VideoChat({ ws, clientId, recipientId }) {
  const [callStatus, setCallStatus] = useState("idle");
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const pcRef = useRef();
  const keyRef = useRef();       // общий AES-GCM ключ
  const iceBuffer = useRef([]); // буфер ICE до remoteDescription

  // 1) Генерируем общий медиа-ключ при монтировании
  useEffect(() => {
    generateKey().then((k) => {
      keyRef.current = k;
    });
  }, []);

  // 2) Шифрование для отправителя
  function setupSenderTransform(sender) {
    if (!sender.createEncodedStreams || sender.track.kind !== "video") return;
    const { readable, writable } = sender.createEncodedStreams();
    const transformer = new TransformStream({
      async transform(chunk, controller) {
        const iv = getIv();
        const encrypted = await encrypt(chunk.data, keyRef.current, iv);
        const out = new Uint8Array(iv.byteLength + encrypted.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(encrypted), iv.byteLength);
        chunk.data = out.buffer;
        controller.enqueue(chunk);
      },
    });
    readable.pipeThrough(transformer).pipeTo(writable);
  }

  // 3) Дешифровка для приёмника
  function setupReceiverTransform(receiver) {
    if (!receiver.createEncodedStreams || receiver.track.kind !== "video")
      return;
    const { readable, writable } = receiver.createEncodedStreams();
    const transformer = new TransformStream({
      async transform(chunk, controller) {
        const data = new Uint8Array(chunk.data);
        const iv = data.slice(0, 12);
        const cipher = data.slice(12).buffer;
        const decrypted = await decrypt(cipher, keyRef.current, iv);
        chunk.data = decrypted;
        controller.enqueue(chunk);
      },
    });
    readable.pipeThrough(transformer).pipeTo(writable);
  }

  // 4) Обработчик WebSocket-сигналинга
  useEffect(() => {
    if (!ws) return;

    const onMsg = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "video_signal") return;

      const pc = pcRef.current;

      // ======== OFFER ========
      if (msg.signalType === "video_offer") {
        const pc = new RTCPeerConnection(iceConfig);
        pcRef.current = pc;
        iceBuffer.current = [];

        // захват локального потока
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localVideoRef.current.srcObject = stream;
        // добавляем треки + шифруем видео-трек
        stream.getTracks().forEach((t) => {
          const sender = pc.addTrack(t, stream);
          setupSenderTransform(sender);
        });

        // ICE кандидаты
        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            ws.send(
              JSON.stringify({
                type: "video_signal",
                signalType: "ice_candidate",
                candidate: ev.candidate,
                clientId,
                recipientId,
              })
            );
          }
        };

        // буферизация приходящих ICE до установки remoteDesc
        const iceHandler = async (ev) => {
          const d = ev.detail;
          if (d.signalType === "ice_candidate") {
            if (pc.remoteDescription) {
              await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
            } else {
              iceBuffer.current.push(d.candidate);
            }
          }
        };
        document.addEventListener("videoSignal", iceHandler);

        // ontrack: сначала вставляем десшифровку, затем привязываем видео
        pc.ontrack = (ev) => {
          setupReceiverTransform(ev.receiver);
          const [remote] = ev.streams;
          remoteVideoRef.current.srcObject = remote;
          setCallStatus("in_call");
        };

        // устанавливаем OFFER и сбрасываем ICE
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
        for (let c of iceBuffer.current) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        iceBuffer.current = [];
        document.removeEventListener("videoSignal", iceHandler);

        // создаём ANSWER и отправляем
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "video_answer",
            answer: pc.localDescription,
            clientId,
            recipientId,
          })
        );
        return;
      }

      // ======== ANSWER ========
      if (msg.signalType === "video_answer" && pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        // декодируем входящие приёмы по-прежнему в ontrack
        setCallStatus("in_call");
        return;
      }

      // ======== ICE ========
      if (msg.signalType === "ice_candidate" && pc) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else {
          iceBuffer.current.push(msg.candidate);
        }
        return;
      }
    };

    ws.addEventListener("message", onMsg);
    return () => ws.removeEventListener("message", onMsg);
  }, [ws, clientId, recipientId]);

  // 5) Инициатор звонка
  const startCall = useCallback(async () => {
    const pc = new RTCPeerConnection(iceConfig);
    pcRef.current = pc;
    iceBuffer.current = [];

    // захват локального потока
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach((t) => {
      const sender = pc.addTrack(t, stream);
      setupSenderTransform(sender);
    });

    // ontrack для приёма
    pc.ontrack = (ev) => {
      setupReceiverTransform(ev.receiver);
      const [remote] = ev.streams;
      remoteVideoRef.current.srcObject = remote;
      setCallStatus("in_call");
    };

    // ICE кандидаты
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "ice_candidate",
            candidate: ev.candidate,
            clientId,
            recipientId,
          })
        );
      }
    };

    // создаём OFFER и отправляем
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
  }, [ws, clientId, recipientId]);

  const endCall = () => {
    pcRef.current?.close();
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
      <div className="video-container">
        <div>
          <h3>Ваше видео</h3>
          <video ref={localVideoRef} autoPlay muted playsInline />
        </div>
        <div>
          <h3>Видео собеседника</h3>
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
      </div>
      <ToastContainer position="bottom-right" autoClose={3000} />
    </div>
  );
}
