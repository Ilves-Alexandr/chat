import Chat from "./components/Chat";
import "./App.css";
import { useState, useEffect } from "react";
import {sendFile, file} from './components/Chat'

function App() {
  const [darkMode, setDarkMode] = useState(false);
  const [fileName, setFileName] = useState("Файл не выбран");

  useEffect(() => {
    document.body.classList.toggle("dark-mode", darkMode);
  }, [darkMode]);

 const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    setFileName(file ? file.name : "Файл не выбран");
  };
  return (
    <div className="App">
      <label htmlFor="darkToggle">
        <input
          id="darkToggle"
          type="checkbox"
          checked={darkMode}
          onChange={(e) => setDarkMode(e.target.checked)}
        />
        Тёмная тема
      </label>
      <div className="input-area">
          {/* Если нужно отправлять файлы */}
          <input
            type="file"
            id="fileInput"
            onChange={handleFileChange}
            className="file-input input"
          />
          <label for="fileInput" className="file_label">Выбрать файл</label>
          <span class="file-name">Файл не выбран</span>
          <button className="file_btn btn" onClick={sendFile} disabled={!file}>
            Отправить файл
          </button>
        </div>
      <Chat />
    </div>
  );
}

export default App;
