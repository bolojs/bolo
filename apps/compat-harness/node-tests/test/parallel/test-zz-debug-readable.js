'use strict';
const common = require('../common');
const Readable = require('stream').Readable;
{
  const underlyingData = ['', 'x', 'y', '', 'z'];
  const result = [];
  const r = new Readable({ encoding: 'utf8' });
  r._read = function() {
    process.nextTick(() => {
      const st = this._readableState;
      const v = underlyingData.length ? underlyingData.shift() : null;
      console.log('pushing', JSON.stringify(v), 'needReadable', st.needReadable, 'emittedReadable', st.emittedReadable, 'reading', st.reading, 'len', st.length);
      this.push(v);
      console.log('  after push: needReadable', st.needReadable, 'emittedReadable', st.emittedReadable, 'reading', st.reading, 'len', st.length);
    });
  };
  r.on('readable', () => {
    const st = r._readableState;
    console.log('readable event; needReadable', st.needReadable, 'emittedReadable', st.emittedReadable, 'len', st.length);
    const data = r.read();
    if (data !== null) result.push(data);
  });
  r.on('end', common.mustCall(() => {
    console.log('end fired', JSON.stringify(result));
  }));
}
