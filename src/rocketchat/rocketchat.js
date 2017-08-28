import log from "../logger";

import _ from "lodash";
import util from "util";
import DDP from "ddp";
import login from "ddp-login";
import promisify from "es6-promisify";
import mdbid from "mdbid";
import EJSON from "ejson";
require("irc-colors").global();

const ROCKETCHAT_HOST = process.env.ROCKETCHAT_HOST;
const ROCKETCHAT_PORT = process.env.ROCKETCHAT_PORT || 443;
const ROCKETCHAT_SECURE = process.env.ROCKETCHAT_SECURE ? process.env.ROCKETCHAT_SECURE === true : true;

const MESSAGE_CACHE_SIZE = 50;

const HIGHLIGHT_TERMS = ["@here", "@channel", "@everyone", "@all"];

export default class RocketChat {
  constructor(connection, username, password) {
    this.connection = connection;

    this.host = ROCKETCHAT_HOST;
    this.port = ROCKETCHAT_PORT;
    this.username = username;
    this.password = password;
    this.secure = ROCKETCHAT_SECURE;

    this.rooms = {};
    this.observers = {};
    this.callDates = {};
    this.userStatuses = {};

    this.messageCache = [];
  }

  async connect() {
    if (this.client) return;

    this.client = new DDP({
      host: this.host,
      port: this.port,
      maintainCollections: true
    });

    this.client.on("message", this.onRawMessage.bind(this));

    await promisify(this.client.connect.bind(this.client))();

    this.userInfo = (await promisify(login)(this.client, {
      account: this.username,
      pass: this.password,
      method: "username",
      retry: 5
    }));

    this.token = this.userInfo.token;

    await this.updateMe();
    await this.subscribeDefault();
    await this.observeDefault();
    await this.updateRooms();
    await this.joinDefaultRooms();
  }

  async updateMe() {
    this.me = _.find(this.client.collections.users, {
      username: this.username
    });
  }

  async subscribeDefault() {
    let uid = this.userInfo.id;

    this.trySubscribe("stream-notify-user", `${uid}/message`, false);
    this.trySubscribe("stream-notify-user", `${uid}/rooms-changed`, false);
    this.trySubscribe("stream-notify-user", `${uid}/subscriptions-changed`, false);
    this.trySubscribe("stream-notify-all", `${uid}/public-settings-changed`, false);
    this.trySubscribe("activeUsers");
    this.trySubscribe("userData");
  }

  async trySubscribe(method, ...params) {
    try {
      await this.subscribe(method, ...params);
    } catch(err) {
      log.error(`Failed to subscribe to ${method}`);
      log.error(err);
    }
  }

  subscribe(method, ...params) {
    return promisify(this.client.subscribe.bind(this.client))(method, [...params]);
  }

  async observeDefault() {
    this.observe("users", (id) => { // user added (online)
      this.setUserActivity(id, true);
    }, () => {}, (id) => { // user removed (offline)
      this.setUserActivity(id, false);
    });
  }

  async logObserve(collection) {
    this.observe(collection, (id) => {
      log.debug(`{green:${collection}} added {blue:${id}}`);
    }, (id) => {
      log.debug(`{blue:${collection}} changed {blue:${id}}`);
    }, (id) => {
      log.debug(`{red:${collection}} removed {blue:${id}}`);
    });

    log.debug(`Now observing {blue:${collection}}`);
  }

  setUserActivity(id, online) {
    this.userStatuses[id] = online;
  }

  observe(collection, added, changed, removed) {
    let observer = this.client.observe(collection);

    if (this.observers[collection]) this.observers[collection].push(observer);
    else this.observers[collection] = [observer];

    observer.added = added;
    observer.changed = changed;
    observer.removed = removed;
  }

  async updateRooms() {
    (await this.callDated("rooms/get")).forEach(room => {
      this.rooms[room._id] = room;
    });
  }

  async joinDefaultRooms() {
    _.forOwn(this.rooms, room => {
      if (room.t === "d") return;
      this.joinRoom(room);
    });
  }

  async joinRoom(room) {
    let ircChannel = this.getIRCChannelName(room);

    this.connection.joinRoom(ircChannel, room.topic);
    await this.getUsersInRoom(room);

    await this.trySubscribe("stream-room-messages", room._id, false);

    let nameList = _.map(room.users, "username");
    this.connection.sendPacket("namesReply", ircChannel, nameList.join(" "));
    this.connection.sendPacket("namesEnd", ircChannel);

    this.sendRoomWho(room);
  }

  async getUsersInRoom(room) {
    let users = (await this.call("getUsersOfRoom", room._id, true)).records;
    let usersObj = {};

    users.forEach(user => {
      usersObj[user._id] = user;
    });

    room.users = usersObj;
  }

  getRoomFromIRCChannel(channel) {
    let t = "c";

    if (channel.startsWith("##")) t = "p";
    else if (!channel.startsWith("#")) t = "d";

    let name = channel.replace(/^##?/, "");
    let room = _.find(this.rooms, { name, t });

    return room;
  }

  getIRCChannelName(room) {
    return `${this.getRoomPrefix(room)}${room.name}`;
  }

  getRoomPrefix(room) {
    return room.t === "c" ? "#" : "##";
  }

  call(method, ...params) {
    return promisify(this.client.call.bind(this.client))(method, [...params]);
  }

  callDated(method, ...params) {
    let date = this.callDates[method] || 0;
    this.callDates[method] = new Date().getTime();

    return this.call(method, [{ $date: date }, ...params]);
  }

  disconnect() {
    if (this.client) {
      this.client.close();
    }
  }

  onRawMessage(msg) {
    log.trace(msg);

    try {
      msg = EJSON.parse(msg);

      if (msg.msg === "changed" && msg.collection === "stream-room-messages") {
        try {
          msg.fields.args.forEach(this.onMessage.bind(this));
        } catch (e) {
          log.error(e);
        }
      }
    } catch (ignored) {}
  }

  onMessage(msg) {
    let room = this.rooms[msg.rid];
    let channel = this.getIRCChannelName(room);
    let nick = msg.u.username;

    let edit = false;

    let oldMsg;
    if (oldMsg = _.find(this.messageCache, { _id: msg._id })) {
      if (oldMsg.msg === msg.msg) return;
      edit = true;
    }

    this.messageCache.push(msg);
    if (this.messageCache.length > MESSAGE_CACHE_SIZE) this.messageCache.shift();

    msg.msg.split("\n").forEach(line => {
      let highlight = false;

      HIGHLIGHT_TERMS.forEach(term => {
        if (line.includes(term)) highlight = true;
      });

      let prefix = edit ? "[EDIT] ".irc.lightgrey() : "";
      let suffix = highlight ? ` (cc: ${this.connection.loginNick})`.irc.red() : "";

      this.connection.sendPacket("privmsg", channel, nick, `${prefix}${line}${suffix}`);
    });
  }

  sendMessage(room, msg) {
    let msgObj = {
      _id: mdbid(),
      rid: room._id,
      msg
    };

    this.messageCache.push(msgObj);
    if (this.messageCache.length > MESSAGE_CACHE_SIZE) this.messageCache.shift();

    this.call("sendMessage", msgObj);
  }

  sendRoomWho(room) {
    let ircChannel = this.getIRCChannelName(room);

    _.forOwn(room.users, user => this.connection.sendPacket("whoReply", user.name, ircChannel, user.name, this.userStatuses[user._id]));
    this.connection.sendPacket("whoEnd", ircChannel);
  }
}