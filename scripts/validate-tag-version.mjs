const pkg=require('./package.json');
const tag=process.env.GITHUB_REF_NAME||'';
const expected='v'+pkg.version;

if(!tag)
  {
    console.error('GITHUB_REF_NAME is required');
    process.exit(1);
  }

if(tag !== expected)
  {
    console.error('Tag '+tag+' does not match package.json version '+expected);
    process.exit(1);
  }
