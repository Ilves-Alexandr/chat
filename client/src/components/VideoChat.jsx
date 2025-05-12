import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";

// AES-GCM key generation и шифрование/дешифрование
async function generateMediaKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}
async function encryptData(data, key, iv) {
  console.log(data.constructor.name, data.byteLength);
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
}
async function decryptData(data, key, iv) {
  console.log(data.constructor.name, data.byteLength);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}
function getRandomIV() {
  return crypto.getRandomValues(new Uint8Array(12));
}

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

export default function VideoChat({ ws, clientId, recipientId }) {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle"); // idle, calling, in_call

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const mediaKeyRef = useRef(null);
  const incomingIceBuffer = useRef([]);

  // ================= transforms =================
  const setupSenderTransform = (sender) => {
    if (!mediaKeyRef.current || sender.track.kind !== "video") return;
    if (!sender.createEncodedStreams) return;
    if (typeof sender.createEncodedStreams !== "function") {
      console.warn("EncodedStreams не поддерживается в этом браузере");
      return;
    }
    let streams;
    try {
      streams = sender.createEncodedStreams();
    } catch (e) {
      console.warn("Sender.createEncodedStreams:", e);
      return;
    }
    const { readable, writable } = streams;
    const t = new TransformStream({
      async transform(frame, ctrl) {
        try {
          console.log(`mediaKeyRef.current::${mediaKeyRef.current}`);
          console.log(frame.data.constructor.name, frame.data.byteLength);
          const iv = getRandomIV();
          const enc = await encryptData(frame.data, mediaKeyRef.current, iv);
          console.log(await encryptData(frame.data, mediaKeyRef.current, iv));
          const ivArr = new Uint8Array(iv),
            encArr = new Uint8Array(enc);
          const buf = new Uint8Array(ivArr.length + encArr.length);
          buf.set(ivArr, 0);
          buf.set(encArr, ivArr.length);
          frame.data = buf.buffer;
          ctrl.enqueue(frame);
        } catch (error) {
          console.error(`setupSenderTransform_error::${error}`);
        }
      },
    });
    readable.pipeThrough(t).pipeTo(writable);
  };

  const setupReceiverTransform = (receiver) => {
    if (!mediaKeyRef.current || receiver.track.kind !== "video") return;
    if (!receiver.createEncodedStreams) return;
    let streams;
    try {
      streams = receiver.createEncodedStreams();
    } catch (e) {
      console.warn("Receiver.createEncodedStreams:", e);
      return;
    }
    const { readable, writable } = streams;
    const t = new TransformStream({
      async transform(frame, ctrl) {
        try {
          console.log(`mediaKeyRef.current::${mediaKeyRef.current}`);
          console.log(frame.data.constructor.name, frame.data.byteLength);
          const arr = new Uint8Array(frame.data);
          const iv = arr.slice(0, 12);
          const enc = arr.slice(12).buffer;
          const dec = await decryptData(enc, mediaKeyRef.current, iv);
          console.log(await decryptData(enc, mediaKeyRef.current, iv));
          frame.data = dec;
          ctrl.enqueue(frame);
        } catch (error) {
          console.error(`setupReceiverTransform_error::${error}`);
        }
      },
    });
    readable.pipeThrough(t).pipeTo(writable);
  };

  // ============ signalling handler ============
  useEffect(() => {
    if (!ws) return;
    (async () => {
      try {
        mediaKeyRef.current = await generateMediaKey();
      } catch (error) {
        console.error(`generateMediaKey()_error:${error}`);
      }
    })();

    const onMessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "video_signal") return;

      // единая точка обработки сигналов
      const pc = pcRef.current;

      // ======== OFFER ========
      if (msg.signalType === "video_offer") {
        // создаём новое соединение
        const pc = new RTCPeerConnection(iceConfig);
        pcRef.current = pc;
        incomingIceBuffer.current = [];

        // добавляем sendrecv-трансиверы до anything
        pc.addTransceiver("video", { direction: "sendrecv" });
        pc.addTransceiver("audio", { direction: "sendrecv" });

        // локальное видео/аудио
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          });
          setLocalStream(stream);
          localVideoRef.current.srcObject = stream;
          stream.getTracks().forEach((t) => {
            const sender = pc.addTrack(t, stream);
            if (typeof sender.createEncodedStreams !== "function") {
              console.warn("EncodedStreams не поддерживается в этом браузере");
              return;
            }
            // setupSenderTransform(sender);
          });
        } catch (error) {
          console.error(`mediaDevices.getUserMedia_error${error}`);
        }

        // свои ICE-кандидаты
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

        // буферизация чужих кандидатов
        document.addEventListener("videoSignal", async (ev) => {
          const d = ev.detail;
          if (d.signalType === "ice_candidate") {
            if (pc.remoteDescription && pc.remoteDescription.type) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
              } catch (error) {
                console.error(`addIceCandidate_error${error}`);
              }
            } else {
              incomingIceBuffer.current.push(d.candidate);
            }
          }
        });

        // принимаем remote stream
        pc.ontrack = (e) => {
          console.log("💥 ontrack fired!", e);
          console.log("  track kind:", e.track.kind);
          console.log("  streams:", e.streams);
          // setupReceiverTransform(e.receiver);
          const [rs] = e.streams;
          console.log("  remoteStream tracks:", rs.getTracks());
          setRemoteStream(rs);
          remoteVideoRef.current.srcObject = rs;
        };

        // ставим оффер
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
          pc.getReceivers().forEach(setupReceiverTransform);
        } catch (error) {
          console.error(`setRemoteDescription_error:${error}`);
        }
        // вываливаем накопленные ICE
        try {
          for (const c of incomingIceBuffer.current) {
            await pc.addIceCandidate(new RTCIceCandidate(c));
          }
          incomingIceBuffer.current = [];
        } catch (error) {
          console.error(`вываливаем накопленные ICE:${error}`);
        }

        // создаём ответ
        try {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
        } catch (error) {
          console.error(`создаём ответ:${error}`);
        }

        ws.send(
          JSON.stringify({
            type: "video_signal",
            signalType: "video_answer",
            answer: pc.localDescription,
            clientId,
            recipientId,
          })
        );
        setCallStatus("in_call");
        return;
      }

      // ======== ANSWER ========
      if (msg.signalType === "video_answer" && pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
          pc.getReceivers().forEach(setupReceiverTransform);
        } catch (error) {
          console.error(`ANSWER:${error}`);
        }
        setCallStatus("in_call");
        return;
      }

      // ======== ICE ========
      if (msg.signalType === "ice_candidate" && pc) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          try {
            console.log("Добавляем ICE-кандидат:", msg.candidate);
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (error) {
            console.error(`ICE:${error}`);
          }
        } else {
          incomingIceBuffer.current.push(msg.candidate);
        }
        return;
      }
    };

    ws.addEventListener("message", onMessage);
    return () => ws.removeEventListener("message", onMessage);
  }, [ws, clientId, recipientId]);

  // ============ Initiator ============
  const startCall = useCallback(async () => {
    // создаём RTCPeerConnection и кладём в ref
    const pc = new RTCPeerConnection(iceConfig);
    pcRef.current = pc;
    incomingIceBuffer.current = [];

    // траснсиверы чтобы получить удалёнку
    pc.addTransceiver("video", { direction: "sendrecv" });
    pc.addTransceiver("audio", { direction: "sendrecv" });

    // локальное
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      localVideoRef.current.srcObject = stream;
      stream.getTracks().forEach((t) => {
        const s = pc.addTrack(t, stream);
        // setupSenderTransform(s);
      });
    } catch (error) {
      console.error(`mediaDevices.getUserMedia:${error}`);
    }

    // remote ontrack
    pc.ontrack = (e) => {
      console.log("💥 ontrack fired!", e);
      console.log("  track kind:", e.track.kind);
      console.log("  streams:", e.streams);
      // setupReceiverTransform(e.receiver);
      const [rs] = e.streams;
      console.log("  remoteStream tracks:", rs.getTracks());
      setRemoteStream(rs);
      remoteVideoRef.current.srcObject = rs;
    };

    // ICE candidates
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

    // self-offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (error) {
      console.error(` self-offer:${error}`);
    }
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
    localStream?.getTracks().forEach((t) => t.stop());
    remoteStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
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
