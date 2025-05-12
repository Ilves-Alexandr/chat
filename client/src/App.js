import Chat from "./components/Chat";
import "./App.css";
import { useState, useEffect } from "react";

function App() {
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    document.body.classList.toggle("dark-mode", darkMode);
  }, [darkMode]);
  const input = document.getElementById("fileInput");
  const fileNameSpan = document.querySelector(".file-name");
  input.addEventListener("change", () => {
    const file = input.files[0];
    fileNameSpan.textContent = file ? file.name : "Файл не выбран";
  });
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
      <Chat />
    </div>
  );
}

export default App;
