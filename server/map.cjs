'use strict';
const {HttpError}=require('./errors.cjs');
// HTTP integrations authorize before reaching this retired entry point.
async function perform(){throw new HttpError(410,'マップは削除されました。','MAP_REMOVED');}
module.exports={perform};
