import Chat from "./components/Chat";
import "./App.css";
import { useState, useEffect } from "react";

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
      <div className="file-upload">
        <input
          id="fileInput"
          type="file"
          onChange={handleFileChange}
        />
        <label htmlFor="fileInput">Выбрать файл</label>
        <span className="file-name">{fileName}</span>
      </div>
      <Chat />
    </div>
  );
}

export default App;
