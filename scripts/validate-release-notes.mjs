import fs from 'fs';

const path='RELEASE_NOTES.md';
if(!fs.existsSync(path))
  {
    console.error('RELEASE_NOTES.md was not generated'); process.exit(1);
  }

const content=fs.readFileSync(path,'utf8').trim();
if(!content || !/^## \[|^- |^### /m.test(content))
  {
    console.error('RELEASE_NOTES.md is empty or invalid');
    process.exit(1);
  }
