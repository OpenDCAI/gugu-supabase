-- 车道 queued-status(owner 10-27):一条还没被 agent 接走的消息,在发送者的气泡上显示「发送中」,直到那个 agent 读了它。
-- 「这条消息给不给这个 agent」只有一份答案:写入时定下的 chat.message_agent_wakes(#6400)。客户端读它,❌ 自己按点名 / 档位再算一遍。
-- 看得见哪一行 = 看得见那条消息:交给 chat.messages 自己的行策略(悄悄话、话题、入群前历史),可见性规则只有一份。
GRANT SELECT ON chat.message_agent_wakes TO authenticated;
CREATE POLICY message_agent_wakes_select_visible ON chat.message_agent_wakes FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM chat.messages m WHERE m.id = message_agent_wakes.message_id));
