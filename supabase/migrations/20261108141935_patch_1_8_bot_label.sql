-- Supabase CLI 2.120.0, db pull patch_1_8_bot_label --local --schema public,private --diff-engine pg-delta --yes.
-- Generated from supabase/sql/25-bot-label.sql applied to clean M01–M30.
-- Replacing the private catalog keeps its existing owner and ACL. All member keys and kits are unchanged.
SET local check_function_bodies = off;

create or replace function private.bot_catalog() returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_object_agg(member_key,jsonb_build_object(
    'key',member_key,'name',name,'level',level,'classId',class_id,'stance',stance,'role',role,
    'allocation',jsonb_build_object('strength',str,'agility',agi,'vitality',vit,'endurance',endurance,'precision',prec),
    'equipment',jsonb_build_object('weapon',weapon,'offHand',off_hand,'head',head,'body',body,'feet',feet),
    'earnedPoints',earned,'peakStrength',gear,'leagueIndex',league_index,'staminaMaximum',stamina,'league',league))
  from (values
    ('tullia','Tullia',12,'guardian','defensive','guard',10,0,18,7,3,
      'sword:10:common','round-shield:10:common','iron-helmet:10:common','light-armor:10:common','light-boots:10:common',38,84,39,115,'silver'),
    ('grit','Grit',7,'berserker','offensive','striker',13,2,7,0,3,
      'axe:5:common',null,'leather-hood:5:common','light-armor:5:common','light-boots:5:common',25,46.28,23,100,'bronze'),
    ('ash','Cinder',7,'duelist','balanced','skirmisher',5,9,2,0,9,
      'sword:5:common',null,'leather-hood:5:common','light-armor:5:common','light-boots:5:common',25,48,23,100,'bronze'),
    ('rufus','Rufus',4,'guardian','defensive','guard',4,0,7,2,1,
      'sword:1:common','round-shield:1:common','iron-helmet:1:common','light-armor:1:common','light-boots:1:common',14,42,14,104,'bronze'),
    ('pip','Pip',3,'duelist','balanced','skirmisher',3,5,1,0,5,
      'sword:1:common',null,'leather-hood:1:common','light-armor:1:common','light-boots:1:common',14,32,11,100,'bronze')
  ) as kit(member_key,name,level,class_id,stance,role,str,agi,vit,endurance,prec,weapon,off_hand,head,body,feet,earned,gear,league_index,stamina,league)
$$;
