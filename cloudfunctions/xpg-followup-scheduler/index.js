const {createHandler}=require('./handler');
const {dispatchFollowups}=require('./dispatch-followups.cjs');
exports.main=createHandler({dispatch:dispatchFollowups});
