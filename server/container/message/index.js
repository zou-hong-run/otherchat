module.exports = {
    List,
    SingleConnect
};
const path = require('path');

let { RespParamErr, RespServerErr, RespExitFriendErr, RespUpdateErr, RespCreateErr } = require('../../model/error');
const { RespError, RespSucess, RespData } = require('../../model/resp');
const { Query } = require('../../db/query');
const fs = require('fs');
const { generateRandomString, notExitCreate } = require('../../utils/utils')
let rooms = {}
/**
 * 获取消息列表
 * 1.先获取好友聊天列表
 * 2.先根据好友分组表中获取当前用户的所有好友分组id,然后根据分组id获取指定房间的用户的所有聊天记录,在根据消息统计表获取最后一次发送消息的时间
 * 3.如何根据对方id和房间号获取未读消息的数量
 * 4.根据房间号和创建时间获取最后一次消息内容
 * 5.根据房间号获取群聊历史记录
 */
async function List(req, res) {
    let data = []
    let id = req.user.id
    //获取所有好友聊天列表
    let sql = `SELECT user_id,avatar,remark as name,f.room,msg_sta.updated_at from friend as f,(SELECT id FROM friend_group WHERE user_id=? LIMIT 1) as fp,message_statistics as msg_sta WHERE fp.id=f.group_id and f.room=msg_sta.room  GROUP BY msg_sta.updated_at DESC;`
    let { err, results } = await Query(sql, [id])
    for (const index in results) {
        let item = results[index]
        sql = `SELECT count(*) as unreadCount FROM message WHERE room=? and receiver_id=? and status=0`
        let r = await Query(sql, [item.room, id])
        results[index].unreadCount = r.results[0].unreadCount
        sql = `SELECT  content as lastMessage,media_type as type FROM message WHERE room=? ORDER BY created_at DESC LIMIT 1`
        r = await Query(sql, [item.room, id])
        results[index].lastMessage = r.results[0].lastMessage
        results[index].type = r.results[0].type
    }
    // 处理 一开始查询结果可能为空 results的值undefined导致报错
    if(results){
        data.push(...results)
    }
    // 查询数据失败
    if (err) return RespError(res, RespServerErr)
    //获取所有群聊聊天列表
    sql = 'SELECT avatar,name,gc.room,msg_sta.updated_at FROM group_chat as gc,(SELECT * FROM group_members WHERE user_id=?) as gm,message_statistics as msg_sta  WHERE gc.id=gm.group_id and gc.room=msg_sta.room  GROUP BY msg_sta.updated_at DESC;'
    let resObj = await Query(sql, [id])
    // 查询数据失败
    if (resObj.err) return RespError(res, RespServerErr)
    let results2 = resObj.results
    data.push(...results2)
    data.sort((a, b) => {
        let t1 = new Date(a.updated_at).getTime()
        let t2 = new Date(b.updated_at).getTime()

        if (t1 < t2) {
            return 1; // a 应该排在 b 前面
        } else if (t1 > t2) {
            return -1; // a 应该排在 b 后面
        } else {
            return 0; // a 和 b 相等，位置不变
        }
    })
    return RespData(res, data)
}
/**
 * 建立聊天
 * 1.获取房间号和对方id
 * 2. 根据房间号获取所有聊天记录
 * 3.将当前用户的所有未读变成已读
 * 4.监听message
 * 5.消息类型目前分为text(文本),image(图片),video(视频),file(文件)
 * 6.text文本不做任何处理
 * 7. image(图片),video(视频),file(文件)先获取文件名,在判断存储的目录是否存在,不存在则创建,然后将其进行保存,并发送相关存储路径给前端
 * 8.插入数据到message表中
 * 9.并修改当前房间的最早一次的聊天时间
 */
async function SingleConnect(ws, req) {
    //获取name
    let url = req.url.split("?")[1];
    let params = new URLSearchParams(url)
    let room = params.get("room")
    let id = params.get("id")
    if (!rooms[room]) {
        rooms[room] = {}
    }
    rooms[room][id] = ws
    let sql = 'SELECT m.*,u.avatar FROM (SELECT sender_id, receiver_id, content, room, media_type,message.created_at FROM message WHERE `room` =? AND `type` = ?  ORDER BY created_at ASC) AS m LEFT JOIN user as u ON u.`id`=m.`sender_id`'
    let { err, results } = await Query(sql, [room, "private"])
    let histroyMsg = results.map((item) => {
        return {
            "sender_id": item.sender_id,
            "receiver_id": item.receiver_id,
            "content": item.content,
            "room": item.room,
            "avatar": item.avatar,
            "type": item.media_type,
            "created_at": new Date(item.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        }
    })
    ws.send(JSON.stringify(histroyMsg))
    //将所有未读消息变成已读
    sql = 'update message set status=1 where receiver_id=? and room=? and type=? and status=0'
    await Query(sql, [id, room, "private"])
    ws.on('message', async (Resp_data) => {
        let message = JSON.parse(Resp_data)
        let fileContent, fileSuffix, filename
        //判断其类型
        let msg = {
            sender_id: message.sender_id,
            receiver_id: message.receiver_id,
            type: 'private',
            media_type: message.type,
            room: room,
        }
        switch (message.type) {
            case 'text':
                msg.content = message.content
                break
            case 'image':
                fileContent = Buffer.from(message.content)
                fileSuffix = message.filename
                    .substring(message.filename.lastIndexOf(".") + 1)
                    .toLowerCase();
                filename = generateRandomString(32) + "." + fileSuffix
                notExitCreate(path.join(__dirname, `../../uploads/message/${room.replace(/-/g, "_")}/images`))
                fs.writeFileSync(path.join(__dirname, `../../uploads/message/${room.replace(/-/g, "_")}/images/${filename}`), fileContent)
                msg.content = `/uploads/message/${room.replace(/-/g, "_")}/images/${filename}`
                message.content = `/uploads/message/${room.replace(/-/g, "_")}/images/${filename}`
                break
            case 'video':
                fileContent = Buffer.from(message.content)
                fileSuffix = message.filename
                    .substring(message.filename.lastIndexOf(".") + 1)
                    .toLowerCase();
                filename = generateRandomString(32) + "." + fileSuffix
                notExitCreate(path.join(__dirname, `../../uploads/message/${room.replace(/-/g, "_")}/video`))
                fs.writeFileSync(path.join(__dirname, `../../uploads/message/${room.replace(/-/g, "_")}/video/${filename}`), fileContent)
                msg.content = `/uploads/message/${room.replace(/-/g, "_")}/video/${filename}`
                message.content = `/uploads/message/${room.replace(/-/g, "_")}/video/${filename}`
                break
            case 'file':
                fileContent = Buffer.from(message.content)
                notExitCreate(path.join(__dirname, `../../uploads/message/${room.replace(/-/g, "_")}/file`))
                fs.writeFileSync(path.join(__dirname, `../../uploads/message/${room.replace(/-/g, "_")}/file/${message.filename}`), fileContent)
                msg.content = `/uploads/message/${room.replace(/-/g, "_")}/file/${message.filename}`
                message.content = `/uploads/message/${room.replace(/-/g, "_")}/file/${message.filename}`
                break
        }
        if (rooms[room][message.receiver_id]) {
            msg.status = 1
        } else {
            msg.status = 0
        }
        sql = 'insert into message set ?'
        await Query(sql, msg)
        sql = `update  message_statistics set total=total+1  where room=?`
        await Query(sql, [room])
        for (const key in rooms[room]) {
            rooms[room][key].send(JSON.stringify(message))
        }
    })
}

async function getAvatar(id) {
    const sql = `select avatar from user where id=?`
    let { results } = await Query(sql, [id])
    return results[0].avatar
}