1. One of the condtions where price is available to the user is that if the fallback source (Goldprice.org) and third source (yahoo) are present, let the user trade. Right now if they both are active but the primary source is not active (PakGold.pk), the trading is paused

2. Right now I've only set the third souce (yahoo) active and it's letting me trade. THIS IS NOT DESIRED BEHAVIOUR. I'm writing all the conditions for you again:
    1. If only Pakgold.pk (primary soruce) is available, let trade continue
    2. If only Goldprice.org (fallback source) is available, DONT let trade continue
    3. If only yahoo (third source mainly used for validation) is available, DONT let trade continue
    4. If Pakgold.pk and Goldprice.org are available, let trade continue
    5. If Goldprice.org and yahoo are availble, let trade continue
    6. If PakGold.pk and yahoo are available, let trade continue.

3. Another thing I want you to do is disable the limit from Max Price Age and Price fetch Interval. 
4. One change regarding UI is that instead of making the "Settings" UI component part of the User page's UI, I want the settings UI to be in the side panel whenever user switches to the User page. It should disappear when the user switches to live database page.
5. Right now when i "reset demo" with only yahoo active, the price is fetched from Yahoo and it let's me trade (WHICH IS NOT DESIRED BEVHAVIOUR). Regardless of if i reset demo or not, a single active price (incase of yahoo and Goldprice.org ) shouldn't let the user trade.