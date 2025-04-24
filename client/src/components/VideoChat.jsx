import React, { useEffect, useRef, useState, useCallback } from "react";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./VideoChat.css";

// AES-GCM media encryption/decryption helpers
async function generateMediaKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}
async function encryptData(data, key, iv) {
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
}
async function decryptData(data, key, iv) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}
function getRandomIV() {
  return crypto.getRandomValues(new Uint8Array(12));
}

const iceConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

const VideoChat = ({ ws, clientId, recipientId }) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callStatus, setCallStatus] = useState("idle"); // idle, calling, in_call
  const [incomingOffer, setIncomingOffer] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const mediaKeyRef = useRef(null);
  const bufferedIce = useRef([]);
  const initializedReceivers = new WeakSet();

  // Устанавливаем шифрование на конкретном Sender
  const setupSenderTransform = (sender) => {
    if (!sender.createEncodedStreams || sender.track.kind !== "video") return;
    let streams;
    try {
      streams = sender.createEncodedStreams();
    } catch (err) {
      console.warn("🔐 Sender.createEncodedStreams failed:", err);
      return;
    }
    const { readable, writable } = streams;
    const transform = new TransformStream({
      async transform(frame, ctrl) {
        try {
          const iv = getRandomIV();
          const enc = await encryptData(frame.data, mediaKeyRef.current, iv);
          const ivArr = new Uint8Array(iv);
          const encArr = new Uint8Array(enc);
          const combined = new Uint8Array(ivArr.length + encArr.length);
          combined.set(ivArr, 0);
          combined.set(encArr, ivArr.length);
          frame.data = combined.buffer;
          ctrl.enqueue(frame);
        } catch (e) {
          console.error("🔐 Encryption error:", e);
        }
      },
    });
    readable.pipeThrough(transform).pipeTo(writable);
    console.log("✅ Sender transform established for sender", sender.track.id);
  };

  // Устанавливаем дешифрование на конкретном Receiver
  const setupReceiverTransform = (receiver) => {
    const pc = pcRef.current;
    if (initializedReceivers.has(receiver)) {
      console.log("⏭ Receiver already initialized, skipping:", receiver.track.id);
      return;
    }
    if (!pc) {
      console.warn(
        "🚫 setupReceiverTransform: RTCPeerConnection not initialized"
      );
      return;
    }
    console.log(
      "🔍 setupReceiverTransform():",
      "track.kind=",
      receiver.track.kind,
      "signalingState=",
      pcRef.current.signalingState,
      "iceConnectionState=",
      pcRef.current.iceConnectionState,
      "receiver.readyState=",
      receiver.track.readyState
    );
    if (!receiver.createEncodedStreams || receiver.track.kind !== "video") {
      console.log("  — skipping transform: unsupported API or not video");
      return;
    }
    let streams;
    try {
      streams = receiver.createEncodedStreams();
    } catch (err) {
      console.error("🔓 Receiver.createEncodedStreams FAILED:", err, {
        signalingState: pcRef.current.signalingState,
        iceConnectionState: pcRef.current.iceConnectionState,
        trackReadyState: receiver.track.readyState,
        bufferedLength: bufferedIce.current.length,
      });
      return;
    }
    initializedReceivers.add(receiver);
    const { readable, writable } = streams;
    const transform = new TransformStream({
      async transform(frame, ctrl) {
        try {
          const dataArr = new Uint8Array(frame.data);
          const iv = dataArr.slice(0, 12);
          const enc = dataArr.slice(12).buffer;
          const dec = await decryptData(enc, mediaKeyRef.current, iv);
          frame.data = dec;
          ctrl.enqueue(frame);
        } catch (e) {
          console.error("🔓 Decryption error:", e);
        }
      },
    });
    readable.pipeThrough(transform).pipeTo(writable);
    console.log(
      "✅ Receiver transform established for receiver",
      receiver.track.id
    );
  };
  useEffect(() => {
    if (!ws) return;
    const onMsg = (e) => {
      const d = JSON.parse(e.data);
      if (d.type !== "video_signal") return;
      if (d.signalType === "video_offer") setIncomingOffer(d);
      else
        document.dispatchEvent(new CustomEvent("videoSignal", { detail: d }));
    };
    ws.addEventListener("message", onMsg);
    return () => ws.removeEventListener("message", onMsg);
  }, [ws]);
  useEffect(() => {
    const handler = async (e) => {
      const d = e.detail;
      const pc = pcRef.current;
      if (!pc) return;
      if (d.signalType === "video_answer") {
        console.log("🔄 [video_answer] setting remote description");
        await pc.setRemoteDescription(new RTCSessionDescription(d.answer));
        console.log(
          "🔄 [after setRemoteDescription] receivers=",
          pc.getReceivers().map((r) => r.track.id)
        );
        bufferedIce.current.forEach(async (cand) => {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
            console.log("✅ Flushed ICE");
          } catch (err) {
            console.warn("Buffered ICE add failed:", err);
          }
        });
        bufferedIce.current = [];
        setCallStatus("in_call");
      } else if (d.signalType === "ice_candidate") {
        if (pc.signalingState === "closed") return;
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          bufferedIce.current.push(d.candidate);
        } else {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(d.candidate));
            console.log("✅ ICE candidate added:", d.candidate);
          } catch (err) {
            console.error("🔴 ICE candidate add error:", err);
          }
        }
      }
    };
    document.addEventListener("videoSignal", handler);
    return () => document.removeEventListener("videoSignal", handler);
  }, []);

  const acceptCall = () => {
    if (incomingOffer) handleOffer(incomingOffer);
    setIncomingOffer(null);
  };
  const rejectCall = () => {
    setIncomingOffer(null);
    toast.info("Звонок отклонён");
  };
  const makeOffer = useCallback(async () => {
    const pc = pcRef.current;
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
  }, [ws, clientId, recipientId]);
  const startCall = async () => {
    if (!mediaKeyRef.current) mediaKeyRef.current = await generateMediaKey();
    const pc = new RTCPeerConnection(iceConfig);
    pcRef.current = pc;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    setLocalStream(stream);
    localVideoRef.current.srcObject = stream;
    stream
      .getTracks()
      .forEach((track) => setupSenderTransform(pc.addTrack(track, stream)));

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
    pc.ontrack = (e) => {
      console.log(
        "📥 [ontrack] track.id=",
        e.receiver.track.id,
        "kind=",
        e.receiver.track.kind,
        "state=",
        e.receiver.track.readyState
      );
      console.log("🔥 calling setupReceiverTransform now");
      setupReceiverTransform(e.receiver);
      console.log("🔥 after setupReceiverTransform");
      const [remote] = e.streams;
      setRemoteStream(remote);
      remoteVideoRef.current.srcObject = remote;
      remoteVideoRef.current.play().catch(() => {});
    };

    await makeOffer();
    setCallStatus("calling");
  };
  const handleOffer = useCallback(
    async (d) => {
      if (!mediaKeyRef.current) mediaKeyRef.current = await generateMediaKey();
      const pc = new RTCPeerConnection(iceConfig);
      pcRef.current = pc;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      localVideoRef.current.srcObject = stream;
      stream
        .getTracks()
        .forEach((track) => setupSenderTransform(pc.addTrack(track, stream)));
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

      pc.ontrack = (e) => {
        console.log(
          "📥 ontrack fired, receiver state:",
          e.receiver.track.readyState
        );
        console.log("🔥 attempting setupReceiverTransform");
        setupReceiverTransform(e.receiver);
        console.log("🔥 setupReceiverTransform done");
        const [remote] = e.streams;
        setRemoteStream(remote);
        remoteVideoRef.current.srcObject = remote;
        remoteVideoRef.current.play().catch(() => {});
      };

      console.log("🔄 [handleOffer] setting remote description");
      await pc.setRemoteDescription(new RTCSessionDescription(d.offer));
      bufferedIce.current.forEach(async (cand) => {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch {}
      });
      bufferedIce.current = [];
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
      setCallStatus("in_call");
    },
    [ws, clientId, recipientId]
  );

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
      {incomingOffer && (
        <div className="incoming-call-banner">
          <p>Входящий звонок от {incomingOffer.clientId}</p>
          <button onClick={acceptCall}>Принять</button>
          <button onClick={rejectCall}>Отклонить</button>
        </div>
      )}
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
};

export default VideoChat;
