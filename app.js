const codeReader = new ZXing.BrowserMultiFormatReader();
const videoElement = document.getElementById('video');
const resultElement = document.getElementById('result');
const historyElement = document.getElementById('history');
let scanHistory = [];

function updateHistory(text) {
  scanHistory.unshift(text);
  if (scanHistory.length > 10) scanHistory.pop();

  historyElement.innerHTML = '';
  scanHistory.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;

    const shareBtn = document.createElement('button');
    shareBtn.textContent = 'Partager';
    shareBtn.className = 'share-btn';
    shareBtn.onclick = () => {
      if (navigator.share) {
        navigator.share({ text: item });
      } else {
        alert('Partage non supporté sur ce navigateur.');
      }
    };

    li.appendChild(shareBtn);
    historyElement.appendChild(li);
  });
}

codeReader
  .listVideoInputDevices()
  .then(videoInputDevices => {
    const selectedDeviceId = videoInputDevices[0].deviceId;

    codeReader.decodeFromVideoDevice(selectedDeviceId, videoElement, (result, err) => {
      if (result) {
        const text = result.getText();
        resultElement.textContent = `Code détecté : ${text}`;
        updateHistory(text);
        console.log("Format : ", result.getBarcodeFormat());
      }
    });
  })
  .catch(err => {
    console.error(err);
    resultElement.textContent = "Erreur d'accès à la caméra.";
  });
