const place = (n,name,parent_id=null)=>({id:`sample-place-${n}`,name,parent_id});
export const sampleLocations=[place(0,'Home'),place(1,'Living room','sample-place-0'),place(2,'Office','sample-place-0'),place(3,'Kitchen','sample-place-0'),place(4,'Storage','sample-place-0'),place(5,'Top shelf','sample-place-2')];
const base={description:'This is a sample item. Add your own photos, purchase details, and notes to start your collection.',serialNumber:'',seller:'Sample shop',purchaseDate:'2026-01-12',currency:'ILS',sourceUrl:'',productUrl:'',quantity:1,status:'active',borrower:'',warrantyDate:''};
export const sampleItems=[
  {id:'sample-camera',art:'camera',data:{...base,name:'Fujifilm camera',brand:'FUJIFILM',model:'X100 series',priceMinor:549000,locationId:'sample-place-5',tags:['Photography','Electronics']}},
  {id:'sample-headphones',art:'headphones',data:{...base,name:'Wireless headphones',brand:'SONY',model:'Wireless headphones',priceMinor:119000,locationId:'sample-place-2',tags:['Electronics','Everyday']}},
  {id:'sample-kettle',art:'kettle',data:{...base,name:'Electric kettle',brand:'FELLOW',model:'Pour-over kettle',priceMinor:69900,locationId:'sample-place-3',tags:['Kitchen']}},
  {id:'sample-lamp',art:'lamp',data:{...base,name:'Table lamp',brand:'MUUTO',model:'Table lamp',priceMinor:89000,locationId:'sample-place-1',tags:['Lighting','Home']}},
  {id:'sample-drill',art:'drill',data:{...base,name:'Cordless drill',brand:'BOSCH',model:'Cordless drill',priceMinor:45900,locationId:'sample-place-4',tags:['Tools']}},
  {id:'sample-speaker',art:'speaker',data:{...base,name:'Portable speaker',brand:'MARSHALL',model:'Portable speaker',priceMinor:79900,locationId:'sample-place-1',tags:['Electronics','Everyday']}},
].map((item,index)=>({...item,revision:1,created_at:'2026-11-01T10:00:00Z',updated_at:`2026-11-${String(15-index).padStart(2,'0')}T10:00:00Z`,updated_by:'Sample owner',comments:[],attachments:[],activity:[]}));
