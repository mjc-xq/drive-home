import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'meshopt.decoder': MeshoptDecoder });
function trs(t,q,s){const[x,y,z,w]=q,x2=x+x,y2=y+y,z2=z+z,xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2,[sx,sy,sz]=s;return[(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0,(xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,(xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0,t[0],t[1],t[2],1];}
function mul(a,b){const o=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];return o;}
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
for (const id of ['cece','mike','kelli','drew']) {
  const doc = await io.read(`src/assets/${id}-mx.glb`);
  const root = doc.getRoot(), scene = root.listScenes()[0];
  const wmOf=new Map();
  const walk=(n,pa)=>{const w=mul(pa,trs(n.getTranslation(),n.getRotation(),n.getScale()));wmOf.set(n,w);for(const c of n.listChildren())walk(c,w);};
  for (const n of scene.listChildren()) walk(n, I);
  const topY = scene.listChildren().map(n=>n.getTranslation()[1]);
  const jointSet=new Set(); for(const sk of root.listSkins())for(const j of sk.listJoints())jointSet.add(j);
  let jointMinY=Infinity; for(const[n,w]of wmOf)if(jointSet.has(n)&&w[13]<jointMinY)jointMinY=w[13];
  // skinned sole min-Y
  let soleY=Infinity;
  for(const sk of root.listSkins()){const joints=sk.listJoints();const ibmAcc=sk.getInverseBindMatrices();const jw=joints.map(j=>wmOf.get(j));
    for(const node of root.listNodes()){if(node.getSkin()!==sk||!node.getMesh())continue;
      for(const prim of node.getMesh().listPrimitives()){const pos=prim.getAttribute('POSITION'),jo=prim.getAttribute('JOINTS_0'),we=prim.getAttribute('WEIGHTS_0');if(!pos||!jo||!we||!ibmAcc)continue;
        const v=[0,0,0],ji=[0,0,0,0],wt=[0,0,0,0],ibm=[];
        for(let i=0;i<pos.getCount();i+=7){pos.getElement(i,v);jo.getElement(i,ji);we.getElement(i,wt);let y=0;
          for(let k=0;k<4;k++){if(wt[k]<=0)continue;ibmAcc.getElement(ji[k],ibm);const m=mul(jw[ji[k]],ibm);y+=(m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13])*wt[k];}
          if(y<soleY)soleY=y;}}}}
  console.log(`${id.padEnd(6)} topNodeY=[${topY.map(v=>v.toFixed(2)).join(',')}]  jointMinY=${jointMinY.toFixed(3)}  skinnedSoleY=${soleY.toFixed(3)}`);
}
