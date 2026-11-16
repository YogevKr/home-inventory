export async function resizedPhoto(file){
  if(!file?.size)return null;
  let bitmap;try{bitmap=await createImageBitmap(file);}catch{throw new Error('Use a JPG, PNG, WebP, or AVIF photo.');}
  const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  let blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.82));
  if(blob?.type!=='image/webp'){ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.82));}
  if(!blob||!['image/webp','image/jpeg'].includes(blob.type))throw new Error('Could not prepare this photo.');
  return new File([blob],`${file.name.replace(/\.[^.]+$/,'')}.${blob.type==='image/webp'?'webp':'jpg'}`,{type:blob.type});
}
