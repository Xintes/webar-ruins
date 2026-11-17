// WebAR Markerless Stage 1. Никаких нейросетей и искусственных меток.
// Результат OpenCV — homography эталонного фото -> текущий кадр.
const $ = (id) => document.getElementById(id);
const video = $("camera"), scene = $("scene"), overlay = $("overlay"), debug = $("debug");
const status = $("status"), hint = $("scan-hint");
const zonePicker = $("zone"), startButton = $("start"), stopButton = $("stop");
const upload = $("file"), showOverlay = $("show-overlay"), showDebug = $("show-debug");
const apiInput = $("api");
const urlParams = new URLSearchParams(location.search);
const savedAPI = localStorage.getItem("webar-cv-api") || "";
const apiOrigin = (urlParams.get("api") || savedAPI).replace(/\/+$/, "");
apiInput.value = apiOrigin;
let stream = null, running = false, busy = false, currentFrame = null;
let currentPose = null, targetPose = null, poseAt = 0, timer = null;
let currentImage = null, currentImageUrl = "";
let imageCanvas = document.createElement("canvas");
let imageCtx = imageCanvas.getContext("2d", {willReadFrequently: false});
let viewW = 0, viewH = 0, lastDraw = 0;
let photoMode = false, photoUrl = null, validUntil = 0;
// Без подключённого Python API камера не должна создавать видимость работающего трекинга.
let apiReady = false;
// Номер сессии предотвращает появление устаревшего результата после остановки камеры.
let trackingGeneration = 0;

function apiPath(path) { return apiOrigin + path; }
function setStatus(message) { status.textContent = message; }
function setHint(message) { hint.textContent = message; }
function setDimensions(width, height) {
  viewW = width; viewH = height;
  scene.style.aspectRatio = `${width}/${height}`;
  scene.style.setProperty("--view-ratio", String(width/height));
  for (const canvas of [overlay, debug]) { canvas.width = width; canvas.height = height; }
  imageCanvas.width = Math.min(960, width);
  imageCanvas.height = Math.round(height * imageCanvas.width / width);
}
function project(H, x, y, scaleX, scaleY) {
  const denominator = H[6]*x + H[7]*y + H[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) return null;
  return { x: scaleX*(H[0]*x + H[1]*y + H[2])/denominator,
           y: scaleY*(H[3]*x + H[4]*y + H[5])/denominator };
}
function drawTriangle(ctx, im, src, dst) {
  if (dst.some((p)=>!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return;
  const [s1,s2,s3] = src; const [p1,p2,p3] = dst;
  const dx1=s2.x-s1.x,dy1=s2.y-s1.y, dx2=s3.x-s1.x,dy2=s3.y-s1.y;
  const determinant = dx1*dy2-dx2*dy1;
  if (Math.abs(determinant)<.0001) return;
  const x1=p2.x-p1.x,x2=p3.x-p1.x,y1=p2.y-p1.y,y2=p3.y-p1.y;
  const a=(x1*dy2-x2*dy1)/determinant,c=(x2*dx1-x1*dx2)/determinant;
  const b=(y1*dy2-y2*dy1)/determinant,d=(y2*dx1-y1*dx2)/determinant;
  const e=p1.x-a*s1.x-c*s1.y, f=p1.y-b*s1.x-d*s1.y;
  ctx.save();ctx.beginPath();ctx.moveTo(p1.x,p1.y);ctx.lineTo(p2.x,p2.y);ctx.lineTo(p3.x,p3.y);
  ctx.closePath();ctx.clip();ctx.setTransform(a,b,c,d,e,f);
  // Маленький исходный прямоугольник вокруг треугольника, без перерисовки всего изображения.
  const left=Math.floor(Math.min(...src.map(p=>p.x))), top=Math.floor(Math.min(...src.map(p=>p.y)));
  const right=Math.ceil(Math.max(...src.map(p=>p.x))), bottom=Math.ceil(Math.max(...src.map(p=>p.y)));
  const sx=Math.max(0,left), sy=Math.max(0,top);
  const sw=Math.min(im.width-sx,right-sx), sh=Math.min(im.height-sy,bottom-sy);
  if (sw>0 && sh>0) ctx.drawImage(im,sx,sy,sw,sh,sx,sy,sw,sh);
  ctx.restore();
}
function drawWarp(ctx, img, H, scaleX, scaleY) {
  const bounds = img._alphaBounds || { x:0,y:0,w:img.width,h:img.height };
  const tile=95;
  for(let y=bounds.y; y<bounds.y+bounds.h; y+=tile){
    for(let x=bounds.x; x<bounds.x+bounds.w; x+=tile){
      const x2=Math.min(x+tile,bounds.x+bounds.w),y2=Math.min(y+tile,bounds.y+bounds.h);
      const a={x,y}, b={x:x2,y}, c={x:x2,y:y2}, d={x,y:y2};
      const aa=project(H,a.x,a.y,scaleX,scaleY),bb=project(H,b.x,b.y,scaleX,scaleY);
      const cc=project(H,c.x,c.y,scaleX,scaleY),dd=project(H,d.x,d.y,scaleX,scaleY);
      drawTriangle(ctx,img,[a,b,c],[aa,bb,cc]); drawTriangle(ctx,img,[a,c,d],[aa,cc,dd]);
    }
  }
}
function findAlphaBounds(img) {
  const canvas=document.createElement('canvas'); canvas.width=img.width;canvas.height=img.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);
  const {data}=ctx.getImageData(0,0,img.width,img.height);
  let minX=img.width,minY=img.height,maxX=-1,maxY=-1;
  for(let y=0;y<img.height;y+=2) for(let x=0;x<img.width;x+=2) {
    if(data[(y*img.width+x)*4+3]>10){minX=Math.min(x,minX);minY=Math.min(y,minY);maxX=Math.max(x,maxX);maxY=Math.max(y,maxY);}
  }
  if(maxX<0) return {x:0,y:0,w:0,h:0};
  return {x:Math.max(0,minX-3),y:Math.max(0,minY-3),w:Math.min(img.width-minX+3,maxX-minX+7),h:Math.min(img.height-minY+3,maxY-minY+7)};
}
async function loadOverlay(pose) {
  const assetUrl=apiPath(pose.overlay_url);
  if (currentImageUrl === assetUrl && currentImage) return;
  const img=new Image(); img.crossOrigin='anonymous'; img.src=assetUrl;
  await img.decode();img._alphaBounds=findAlphaBounds(img);
  if(img.width !== pose.image_width || img.height !== pose.image_height)
    throw new Error('Эталон и наложение имеют разные размеры');
  currentImage=img;currentImageUrl=assetUrl;
}
function clearTracking(){targetPose=null;currentPose=null;currentImage=null;currentImageUrl='';validUntil=0;
 overlay.getContext('2d').clearRect(0,0,overlay.width,overlay.height);
 debug.getContext('2d').clearRect(0,0,debug.width,debug.height);}
function resetTrackingAfterLoss(){targetPose=null;currentPose=null;
 overlay.getContext('2d').clearRect(0,0,overlay.width,overlay.height);
 debug.getContext('2d').clearRect(0,0,debug.width,debug.height);}
function render(ts) {
  if (viewW && viewH && ts-lastDraw>65) {
    lastDraw=ts;
    const ctx=overlay.getContext('2d');ctx.clearRect(0,0,viewW,viewH);
    const dbg=debug.getContext('2d');dbg.clearRect(0,0,viewW,viewH);
    if(targetPose && ts<validUntil && currentImage){
      // Небольшое сглаживание результатов сервера между обновлениями.
      const H=targetPose.homography;
      if (!currentPose || currentPose.length!==9) currentPose=H.slice();
      for(let j=0;j<9;j++) currentPose[j]+=0.35*(H[j]-currentPose[j]);
      const sx=viewW/targetPose.frame_width,sy=viewH/targetPose.frame_height;
      if(showOverlay.checked) drawWarp(ctx,currentImage,currentPose,sx,sy);
      if(showDebug.checked){
        dbg.beginPath();const region=targetPose.roi_polygon;
        region.forEach((p,i)=>{const x=p[0]*sx,y=p[1]*sy;
          if(i===0)dbg.moveTo(x,y);else dbg.lineTo(x,y);});
        dbg.closePath();dbg.strokeStyle='#32ffad';dbg.lineWidth=3;dbg.stroke();
      }
    } else if(targetPose && ts>=validUntil){resetTrackingAfterLoss();setHint('Ракурс потерян — наведите камеру на башню');}
  }
  requestAnimationFrame(render);
}
async function analyze(blob, generation = trackingGeneration) {
  const fd=new FormData();fd.append('frame',blob,'frame.jpg');fd.append('zone',zonePicker.value);
  const started=performance.now();
  const response=await fetch(apiPath('/api/track/frame'),{method:'POST',body:fd,cache:'no-store'});
  if(!response.ok) throw new Error(`API ${response.status}: ${(await response.text()).slice(0,140)}`);
  const result=await response.json();
  if (generation !== trackingGeneration) return;
  if(!result.found){if(performance.now()>validUntil){resetTrackingAfterLoss();setHint('Не найдено — приблизьтесь к опорному ракурсу');}
    setStatus(`OpenCV: ${result.reason||'Нет совпадений'}. Время запроса ${Math.round(performance.now()-started)} мс`);return;}
  await loadOverlay(result);
  if (generation !== trackingGeneration) return;
  if(targetPose?.view!==result.view) currentPose=null;
  targetPose=result;poseAt=performance.now();validUntil=photoMode ? Infinity : performance.now()+1500;
  setHint('Башня распознана · стена привязана');
  setStatus(`Ракурс: ${result.view_label} · ${result.algorithm} · подтверждённых точек: ${result.inliers} · ошибка: ${result.median_error_px} px · запрос: ${Math.round(performance.now()-started)} мс`);
}
async function sendCameraFrame(){
  if(!running||busy||video.readyState<2)return;
  busy=true;
  const generation = trackingGeneration;
  try{imageCtx.drawImage(video,0,0,imageCanvas.width,imageCanvas.height);
    const blob=await new Promise(r=>imageCanvas.toBlob(r,'image/jpeg',.72));
    if(blob&&running&&generation===trackingGeneration)await analyze(blob,generation);
  }catch(e){setStatus(`Ошибка: ${e.message}`);}
  finally{busy=false;}
}
async function startCamera(){
  if(running)return;
  if (!apiReady) {
    setStatus('OpenCV API не подключён. GitHub Pages не выполняет Python: запусти FastAPI на ПК или настрой HTTPS API внизу страницы.');
    return;
  }
  if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia){
    setStatus('Для камеры необходим HTTPS либо localhost. На IP с HTTP камера не включится.');return;
  }
  startButton.disabled=true;
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
    video.srcObject=stream;await video.play();
    setDimensions(video.videoWidth,video.videoHeight);
    trackingGeneration++;
    photoMode=false;running=true;video.hidden=false;
    stopButton.disabled=false;startButton.disabled=true;
    clearTracking();setHint('Направьте камеру на башню');
    timer=setInterval(sendCameraFrame,520);sendCameraFrame();
  }catch(e){setStatus(`Камера не запустилась: ${e.message}`);stream?.getTracks().forEach(t=>t.stop());stream=null;startButton.disabled=false;}
}
function stopCamera(){
  trackingGeneration++;
  running=false;clearInterval(timer);timer=null;
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  video.pause();video.srcObject=null;video.hidden=true;
  startButton.disabled=false;stopButton.disabled=true;
  resetTrackingAfterLoss();setHint('Камера выключена');
}
async function analyzeImageFile(file){
  stopCamera();
  const bmp=await createImageBitmap(file);
  setDimensions(bmp.width,bmp.height);
  photoMode=true;
  const generation = trackingGeneration;
  // Показываем загруженную фотографию в той же области как видеокадр.
  const canvas=document.createElement('canvas'); canvas.width=bmp.width;canvas.height=bmp.height;
  canvas.getContext('2d').drawImage(bmp,0,0);bmp.close();
  const data=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.85));
  if(photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl=URL.createObjectURL(data);const url=photoUrl;
  // Подложка через background, чтобы изображение не мешало overlay.
  scene.style.backgroundImage=`url("${url}")`;
  scene.style.backgroundSize='100% 100%';
  if (!apiReady) {setStatus('Нет подключения к OpenCV API. Открой страницу с работающего локального FastAPI или укажи HTTPS-сервер.');return;}
  try{await analyze(data,generation);}catch(e){setStatus(`Ошибка проверки фото: ${e.message}`);}
}
async function loadZones(){
  const response=await fetch(apiPath('/api/track/zones'));
  if(!response.ok)throw new Error('Нет доступа к API; проверь запуск FastAPI');
  const data=await response.json();
  zonePicker.replaceChildren();
  for(const z of data.zones){const opt=document.createElement('option');opt.value=z.id;opt.textContent=`${z.label} (${z.views} ракурсов)`;zonePicker.appendChild(opt);}
  apiReady = data.zones.length > 0;
  startButton.disabled = !apiReady;
  if(apiReady) setStatus('OpenCV API подключён. Включи камеру или загрузи фотографию.');
  else setStatus('На сервере не зарегистрированы обзорные зоны.');
}
$('start').addEventListener('click',()=>{scene.style.backgroundImage='none';startCamera();});
$('stop').addEventListener('click',stopCamera);
upload.addEventListener('change',async()=>{const file=upload.files[0];if(file){try{await analyzeImageFile(file);}catch(e){setStatus(e.message);}upload.value='';}});
zonePicker.addEventListener('change',clearTracking);
$('save-api').addEventListener('click',()=>{const val=apiInput.value.trim().replace(/\/+$/,'');
  if(val && (!val.startsWith('https://')&&!val.startsWith('http://localhost'))) {setStatus('Для телефона нужен HTTPS API');return;}
  localStorage.setItem('webar-cv-api',val);location.reload();});
window.addEventListener('pagehide',()=>{stopCamera();if(photoUrl) URL.revokeObjectURL(photoUrl);});
// На GitHub Pages файл /api/track/zones отсутствует: там только статические страницы.
if (!apiOrigin && location.hostname.endsWith('.github.io')) {
  startButton.disabled = true;
  setStatus('Нет OpenCV API. GitHub Pages публикует страницу, но не Python-сервер. Для распознавания открой локальный http://localhost:8000/track/ с запущенным FastAPI или укажи HTTPS API.');
} else {
  startButton.disabled = true;
  loadZones().catch(e=>{
    apiReady = false;
    startButton.disabled = true;
    setStatus(`Нет соединения с OpenCV API: ${e.message}. Проверь запуск FastAPI и адрес API внизу страницы.`);
  });
}
requestAnimationFrame(render);
